'use strict';
// Finds devices (discover) and lists their points (browse), inside the scan
// windows set for the site. "Scan now" from the setup page ignores the window.

function inWindow(windows, d = new Date()) {
  if (!windows || !windows.length || windows.includes('any')) return true;
  const m = d.getHours() * 60 + d.getMinutes();
  return windows.some(w => {
    const [a, b] = w.split('-').map(s => { const [h, mm] = s.split(':').map(Number); return h * 60 + (mm || 0); });
    return a <= b ? m >= a && m < b : m >= a || m < b; // windows may cross midnight
  });
}

class Scanner {
  constructor({ store, drivers, settings, log, onChange = () => {} }) {
    Object.assign(this, { store, drivers, settings, log, onChange });
    this.state = { running: false, phase: null, progress: null, last_start: null, last_end: null, last_result: null, last_error: null };
    this.browseQueue = new Map(); // deviceId -> reason
    this.browsedAt = new Map();
  }

  due(now = Date.now()) {
    const s = this.settings().scan;
    const last = this.store.getMeta('scan_last_end', 0);
    if (!last) return s.at_start !== false;
    return now - last >= (s.every_h || 24) * 3600000;
  }

  // List one device's points again (points missing, device replaced). At most hourly per device.
  requestBrowse(dev, reason) {
    const last = this.browsedAt.get(dev.id) || 0;
    if (Date.now() - last < 3600000 || this.browseQueue.has(dev.id)) return;
    this.browseQueue.set(dev.id, reason);
  }

  async browseQueued() {
    for (const [id, reason] of this.browseQueue) {
      this.browseQueue.delete(id);
      const d = this.store.deviceById(id);
      const host = d && this.drivers[d.driver];
      if (!host || !host.ready) continue;
      this.browsedAt.set(id, Date.now());
      this.log('info', `listing points of ${d.name} again (${reason})`);
      const res = { points_new: 0, points_changed: 0, points_missing: 0 };
      try { await this.browseDevice(host, d, res); } catch (e) { this.log('warn', `could not list points on ${d.name} (${e.code || e.message})`); }
      this.log('info', `${d.name}: ${res.points_new} new, ${res.points_missing} gone`);
      this.onChange();
    }
  }

  async browseDevice(host, d, res) {
    const s = this.settings();
    const dcfg = s.drivers[d.driver] || {};
    const keys = [];
    await host.call('browse', { device: d, rate: dcfg.rate_per_device || 5 }, {
      idleMs: 60000,
      onEvent: (ev, p) => {
        if (ev !== 'point') return;
        keys.push(p.key);
        const r = this.store.upsertPoint(d.id, p, { selected: s.scan.auto_select !== 'none', interval_s: s.poll.default_interval_s || 900 });
        if (r === 'created') res.points_new++; else if (r === 'changed') res.points_changed++;
      },
    });
    res.points_missing += this.store.markMissing(d.id, keys);
    this.store.setDeviceStatus(d.id, { browsed_at: Date.now() });
  }

  tick() {
    if (this.state.running) return;
    if (this.browseQueue.size && !this.browsing) {
      this.browsing = true;
      this.browseQueued().finally(() => { this.browsing = false; });
    }
    if (this.state.last_error && Date.now() - this.state.last_end < 30 * 60000) return; // wait after a failed scan
    const s = this.settings().scan;
    if (this.due() && inWindow(s.windows)) this.run('schedule').catch(() => {});
  }

  async run(reason = 'manual', { browseAll = false } = {}) {
    if (this.state.running) return { already: true };
    const st = this.state;
    Object.assign(st, { running: true, phase: 'discover', progress: null, last_start: Date.now(), last_error: null });
    const res = { reason, devices: 0, new_devices: 0, browsed: 0, points_new: 0, points_changed: 0, points_missing: 0, errors: 0 };
    const s = this.settings();
    try {
      for (const [name, host] of Object.entries(this.drivers)) {
        if (!host.ready) { this.log('warn', `scan: ${name} driver not ready`); continue; }
        const dcfg = s.drivers[name] || {};
        const seen = [];
        const known = this.store.devices().filter(d => d.driver === name).map(d => ({ key: d.key, route: d.route }));
        await host.call('discover', { targets: dcfg.targets || {}, timeout_s: dcfg.discover_timeout_s || 5, rate: dcfg.net_rate || 10, known }, {
          idleMs: 120000,
          onEvent: (ev, data) => {
            if (ev === 'device') {
              const r = this.store.upsertDevice(name, data);
              res.devices++; if (r.created) res.new_devices++;
              seen.push(r.device);
            } else if (ev === 'progress') st.progress = data;
          },
        });
        this.log('info', `scan: ${name} found ${seen.length} devices (${res.new_devices} new)`);
        st.phase = 'browse';
        const stale = (s.scan.browse_every_h || 168) * 3600000;
        const toBrowse = seen.filter(d => browseAll || !d.browsed_at || Date.now() - d.browsed_at > stale);
        let i = 0;
        for (const d of toBrowse) {
          st.progress = { done: i++, of: toBrowse.length, device: d.name };
          try {
            await this.browseDevice(host, d, res);
            this.onChange(); // start reading this device's points without waiting for the whole scan
            res.browsed++;
          } catch (e) {
            res.errors++;
            this.store.setDeviceStatus(d.id, { last_error: `browse: ${e.message}` });
            this.log('warn', `scan: could not list points on ${d.name} (${e.code || e.message})`);
          }
        }
      }
      st.last_result = res;
      this.store.setMeta('scan_last_end', Date.now());
      this.log('info', `scan done: ${res.devices} devices, ${res.browsed} listed, ${res.points_new} new points, ${res.points_missing} gone`);
      return res;
    } catch (e) {
      st.last_error = e.message;
      this.log('error', `scan failed: ${e.message}`);
      throw e;
    } finally {
      st.running = false; st.phase = null; st.progress = null; st.last_end = Date.now();
      this.onChange();
    }
  }
}

module.exports = { Scanner, inWindow };
