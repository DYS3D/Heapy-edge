'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = t => {
    if (!t) return '—';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(t).toLocaleString();
  };
  const ivText = s => s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`;

  async function api(path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-edge': '1' }, body: JSON.stringify(body) };
    const r = await fetch('/api/' + path, opt);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('signed out'); }
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }

  // ---- sign in ----
  let setupMode = false;
  async function boot() {
    const s = await api('session');
    if (s.authed) return showMain();
    showLogin(s.needs_password);
  }
  function showLogin(needs) {
    $('#main').hidden = true; $('#login').hidden = false;
    if (needs !== undefined) setupMode = needs;
    $('#login-title').textContent = setupMode ? 'Set a password' : 'Sign in';
    $('#login-help').textContent = setupMode ? 'First start: choose a password for this setup page (at least 10 characters).' : 'Enter the setup page password for this box.';
    $('#pw2').hidden = $('#pw2-label').hidden = !setupMode;
    $('#login-btn').textContent = setupMode ? 'Set password' : 'Sign in';
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try {
      if (setupMode) {
        if ($('#pw').value !== $('#pw2').value) throw new Error('The two passwords are different.');
        await api('setup-password', { password: $('#pw').value });
      } else await api('login', { password: $('#pw').value });
      $('#pw').value = $('#pw2').value = '';
      showMain();
    } catch (err) { $('#login-err').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('logout', {}); showLogin(false); });

  // ---- tabs ----
  let tab = 'status';
  try { tab = localStorage.getItem('edge.tab') || 'status'; } catch { /* no storage */ }
  function setTab(t) {
    tab = t;
    try { localStorage.setItem('edge.tab', t); } catch { /* no storage */ }
    document.querySelectorAll('.hp-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === t));
    document.querySelectorAll('[data-page]').forEach(p => { p.hidden = p.dataset.page !== t; });
    refresh();
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.hp-tab'); if (b) setTab(b.dataset.tab); });

  let timer;
  function showMain() {
    $('#login').hidden = true; $('#main').hidden = false;
    setTab(tab);
    clearInterval(timer);
    timer = setInterval(() => { if (['status', 'devices', 'log'].includes(tab)) refresh(); }, 5000);
  }

  async function refresh() {
    try {
      const st = await api('status');
      renderMeta(st);
      if (tab === 'status') renderStatus(st);
      if (tab === 'devices') await renderDevices();
      if (tab === 'points') await renderPoints();
      if (tab === 'connect') renderConnect(st);
      if (tab === 'settings') await renderSettings();
      if (tab === 'log') await renderLog();
    } catch (e) { if (e.message !== 'signed out') console.error(e); }
  }

  function renderMeta(st) {
    const l = st.link;
    $('#meta').innerHTML = `
      <div class="hp-meta"><span class="hp-label">Box</span><span class="hp-num">${esc(st.name)}</span></div>
      <div class="hp-meta"><span class="hp-label">Connected to HEAPY</span><span class="hp-num">${l.paired ? esc(l.site || l.box_id) : 'Not yet'}</span></div>
      <div class="hp-meta"><span class="hp-label">Version</span><span class="hp-num">${esc(st.version)}</span></div>`;
    $('#foot').textContent = `${st.host} · up ${Math.round(st.health.uptime_s / 3600)} h`;
  }

  function renderStatus(st) {
    const h = st.health;
    const k = (v, label, sub, cls = '') => `<div class="hp-kpi ${cls}"><div class="hp-kpi__value">${esc(v)}</div><span class="hp-label">${label}</span><div class="hp-kpi__sub">${sub}</div></div>`;
    $('#kpis').innerHTML =
      k(h.devices, 'Devices', `${h.devices_offline} not answering`, h.devices_offline ? 'hp-kpi--high' : 'hp-kpi--accent') +
      k(h.selected, 'Points trended', `of ${h.points} found`) +
      k(h.late_points, 'Late points', 'missed 2 or more readings', h.late_points ? 'hp-kpi--high' : 'hp-kpi--pass') +
      k(h.backlog_samples ?? '—', 'Waiting to send', h.oldest_unsent_ms ? `oldest ${ago(h.oldest_unsent_ms)}` : 'nothing waiting') +
      k(`${h.buffer_mb} MB`, 'Buffer', h.disk_free_mb != null ? `${Math.round(h.disk_free_mb / 1024)} GB free` : '');
    const sc = st.scan;
    const r = sc.last_result;
    $('#scan-box').innerHTML = `<dl class="kv">
      <dt>Now</dt><dd>${sc.running ? `${esc(sc.phase)}${sc.progress ? ` ${sc.progress.done}/${sc.progress.of} ${esc(sc.progress.device || '')}` : ''}` : 'idle'}</dd>
      <dt>Last scan</dt><dd>${ago(sc.last_end)}</dd>
      ${r ? `<dt>Found</dt><dd>${r.devices} devices (${r.new_devices} new), ${r.points_new} new points, ${r.points_missing} gone</dd>` : ''}
      ${sc.last_error ? `<dt>Problem</dt><dd>${esc(sc.last_error)}</dd>` : ''}
      <dt>Reads</dt><dd>${st.poll.reads} (${st.poll.read_errors} failed), ${st.poll.samples} values</dd>
      <dt>Drivers</dt><dd>${Object.entries(st.drivers).map(([n, d]) => `${esc(n)} ${d.ready ? 'ready' : 'not running'}`).join(', ') || 'none'}</dd></dl>`;
    $('#scan-now').disabled = sc.running;
    $('#send-box').innerHTML = Object.entries(st.destinations).map(([n, d]) => `<dl class="kv">
      <dt>${esc(n)}</dt><dd>${d.enabled ? 'on' : 'off'}${d.url ? ' · ' + esc(d.url) : ''}</dd>
      ${d.enabled ? `<dt>Last sent</dt><dd>${ago(d.last_ok)}</dd><dt>Waiting</dt><dd>${d.backlog} values</dd>${d.last_error ? `<dt>Problem</dt><dd>${esc(d.last_error)}</dd>` : ''}` : ''}</dl>`).join('<hr>');
  }
  $('#scan-now').addEventListener('click', async () => { try { await api('scan', {}); refresh(); } catch (e) { alertBox(e.message); } });

  let devices = [];
  async function renderDevices() {
    devices = await api('devices');
    const f = $('#dev-filter').value.toLowerCase();
    $('#dev-rows').innerHTML = devices.filter(d => !f || `${d.name} ${d.key} ${d.vendor} ${d.model} ${d.route}`.toLowerCase().includes(f)).map(d => `<tr>
      <td><span class="dot ${d.points ? esc(d.status) : ''}"></span>${d.points ? esc(d.status) : 'no points'}</td><td>${esc(d.name)}</td><td class="mono">${esc(d.key)}</td><td class="mono">${esc(d.route)}</td>
      <td>${esc([d.vendor, d.model].filter(Boolean).join(' · '))}</td><td class="num">${d.points}</td><td class="num">${d.selected || 0}</td><td>${esc(d.last_error || '')}</td></tr>`).join('') ||
      '<tr><td colspan="8" class="hp-empty">No devices yet. Check the BAS port address in Settings, then Scan now.</td></tr>';
  }
  $('#dev-filter').addEventListener('input', renderDevices);

  let points = [];
  async function renderPoints() {
    if (!devices.length) devices = await api('devices');
    const sel = $('#pt-device');
    const cur = sel.value;
    sel.innerHTML = devices.map(d => `<option value="${d.id}">${esc(d.name)} (${d.points})</option>`).join('');
    if (cur) sel.value = cur;
    if (!sel.value) { $('#pt-rows').innerHTML = '<tr><td colspan="8" class="hp-empty">No devices yet.</td></tr>'; return; }
    points = await api('points?device=' + sel.value);
    drawPoints();
  }
  function shownPoints() {
    const f = $('#pt-filter').value.toLowerCase();
    return points.filter(p => !p.missing && (!f || `${p.name} ${p.description} ${p.key}`.toLowerCase().includes(f)));
  }
  function drawPoints() {
    const shown = shownPoints();
    $('#pt-count').textContent = `${shown.length} shown, ${points.filter(p => p.selected).length} trended`;
    $('#pt-rows').innerHTML = shown.map(p => `<tr>
      <td><input type="checkbox" class="pt-sel" data-key="${esc(p.key)}" ${p.selected ? 'checked' : ''} aria-label="Trend ${esc(p.name)}"></td>
      <td>${esc(p.name)}</td><td>${esc(p.description)}</td><td class="mono">${esc(p.key.split('/').pop())}</td><td>${esc(p.units || (p.states || []).join(' / '))}</td>
      <td class="num">${ivText(p.interval_s)}${p.cov_active ? ' + COV' : ''}</td><td class="num">${p.last_v ?? '—'}</td><td>${ago(p.last_t)}</td></tr>`).join('');
  }
  $('#pt-device').addEventListener('change', renderPoints);
  $('#pt-filter').addEventListener('input', drawPoints);
  $('#pt-rows').addEventListener('change', async e => {
    const c = e.target.closest('.pt-sel'); if (!c) return;
    await api('points', { changes: [{ key: c.dataset.key, selected: c.checked }] });
    const p = points.find(x => x.key === c.dataset.key); if (p) p.selected = c.checked ? 1 : 0;
    drawPoints();
  });
  async function bulk(change) { await api('points', { changes: shownPoints().map(p => ({ key: p.key, ...change })) }); renderPoints(); }
  $('#pt-all').addEventListener('click', () => bulk({ selected: true }));
  $('#pt-none').addEventListener('click', () => bulk({ selected: false }));
  $('#pt-iv-apply').addEventListener('click', () => bulk({ interval_s: Number($('#pt-iv').value) }));

  function renderConnect(st) {
    const l = st.link;
    $('#pair-state').innerHTML = l.paired
      ? `<p>Connected to <b>${esc(l.server)}</b> as <b>${esc(l.box_id)}</b>${l.site ? ` for ${esc(l.site)}` : ''}. Last check-in ${ago(l.last_checkin)}${l.last_error ? ` · problem: ${esc(l.last_error)}` : ''}.</p>
         <p><button class="hp-btn hp-btn--sm" id="unpair">Disconnect</button></p>`
      : '<p>This box is not connected yet. Make a pairing code in Trend Tracker (Sites and boxes), then enter it here.</p>';
    $('#pair-form').hidden = l.paired;
    const u = $('#unpair');
    if (u) u.addEventListener('click', async () => { await api('unpair', {}); refresh(); });
  }
  $('#pair-form').addEventListener('submit', async e => {
    e.preventDefault(); $('#pair-err').textContent = '';
    try { await api('pair', { url: $('#pair-url').value, code: $('#pair-code').value }); $('#pair-code').value = ''; refresh(); } catch (err) { $('#pair-err').textContent = err.message; }
  });

  let settings;
  async function renderSettings() {
    settings = await api('settings');
    const b = settings.drivers['bacnet-ip'];
    $('#s-name').value = settings.name;
    $('#s-addr').value = b.settings.address || 'host';
    $('#s-inst').value = b.settings.instance;
    $('#s-bbmd').value = b.settings.foreign_bbmd || '';
    $('#s-rate').value = b.rate_per_device;
    $('#s-win').value = (settings.scan.windows || ['any']).join(', ');
    $('#s-every').value = settings.scan.every_h;
    $('#s-auto').value = settings.scan.auto_select;
    $('#s-iv').value = String(settings.poll.default_interval_s);
    $('#s-cov').value = String(!!settings.poll.use_cov);
    $('#s-keep').value = settings.buffer.keep_days;
    $('#s-files').value = String(!!(settings.destinations.find(d => d.name === 'files') || {}).enabled);
  }
  $('#set-form').addEventListener('submit', async e => {
    e.preventDefault(); $('#set-err').textContent = ''; $('#set-ok').textContent = '';
    const b = settings.drivers['bacnet-ip'];
    const bs = { ...b.settings, address: $('#s-addr').value.trim() || 'host', instance: Number($('#s-inst').value) };
    if ($('#s-bbmd').value.trim()) bs.foreign_bbmd = $('#s-bbmd').value.trim(); else delete bs.foreign_bbmd;
    try {
      await api('settings', {
        name: $('#s-name').value.trim() || 'HEAPY Edge',
        drivers: { 'bacnet-ip': { settings: bs, rate_per_device: Number($('#s-rate').value) } },
        scan: { windows: $('#s-win').value.split(',').map(s => s.trim()).filter(Boolean), every_h: Number($('#s-every').value), auto_select: $('#s-auto').value },
        poll: { default_interval_s: Number($('#s-iv').value), use_cov: $('#s-cov').value === 'true' },
        buffer: { keep_days: Number($('#s-keep').value) },
        destinations: settings.destinations.map(d => d.name === 'files' ? { ...d, enabled: $('#s-files').value === 'true' } : d),
      });
      $('#set-ok').textContent = 'Saved';
      renderSettings();
    } catch (err) { $('#set-err').textContent = err.message; }
  });

  async function renderLog() {
    const rows = await api('log');
    $('#log').innerHTML = rows.slice().reverse().map(r => `<span class="${esc(r.level)}">${new Date(r.t).toLocaleString()}  ${esc(r.msg)}</span>`).join('\n');
  }

  function alertBox(msg) { $('#scan-box').insertAdjacentHTML('afterbegin', `<p class="err">${esc(msg)}</p>`); }

  boot();
})();
