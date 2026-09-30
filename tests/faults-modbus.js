'use strict';
// HEAPY Edge fault tests for the Modbus driver (Linux root).
// Simulated site: Modbus TCP devices, a TCP-to-RS-485 gateway, an RTU-over-TCP
// serial server and RTU devices on a virtual RS-485 bus. Faults are injected in
// the devices, the gateway, the bus, the network, the driver and the box.
//   node tests/faults-modbus.js [--stages main,config,big] [--only "a|b"] [--out file]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Lab, sleep, ROOT } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
const STAGES = new Set(arg('stages', 'main,config,big').split(','));
const OUT = arg('out', path.join(ROOT, 'fault-report-modbus.json'));
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn, lab) {
  if (ONLY && !ONLY.has(name)) return;
  const t = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    const d = await fn(lab) || {};
    results.push({ name, pass: true, secs: Math.round((Date.now() - t) / 1000), detail: d });
    console.log(`  ✔ ${name} (${Math.round((Date.now() - t) / 1000)} s) ${JSON.stringify(d).slice(0, 300)}`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`  ✘ ${name}: ${e.message}`);
  }
}
const K = n => `modbus://${n}`;
const lastRead = (lab, k) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, k)[0].t || 0;
const status = (lab, n) => (lab.device(K(n)) || {}).status;
// points that always read as an error on purpose (NaN, "not available")
const ERROR_POINTS = k => /\/holding:(25|26)\?/.test(k);

// Every stored reading of a point with a fixed value must be exactly that value:
// a fault may cost a reading, never produce a wrong one.
function wrongValues(lab, since = 0) {
  const exp = lab.mbTemplates.meter.expected;
  const bigExp = lab.mbTemplates.big.expected;
  const rows = lab.q(`SELECT p.name, d.key dkey, s.v, s.t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE s.t>=?`, since);
  const bad = [];
  let checked = 0;
  for (const r of rows) {
    const w = exp[r.name] ?? bigExp[r.name];
    if (w === undefined) continue;
    if (typeof w === 'string') {
      if (w.startsWith('range:')) { const [, lo, hi] = w.split(':').map(Number); checked++; if (!(r.v >= lo && r.v <= hi)) bad.push(r); }
      continue;
    }
    if (w === null) { bad.push(r); continue; }
    checked++;
    if (Math.abs(r.v - w) > Math.abs(w) * 1e-6) bad.push(r);
  }
  return { checked, bad };
}

async function faultTest(lab, name, { dev, f, v = true, secs = 120, keys, noGapsFor = null, sim }) {
  return test(name, async () => {
    const t = Date.now();
    if (sim) await lab.simctl(sim(true)); else for (const d of [].concat(dev)) await lab.simctl({ cmd: 'fault', dev: d, f, v, on: true });
    for (const k of keys || []) lab.fault(k, t, null, name);
    await sleep(secs * 1000);
    if (sim) await lab.simctl(sim(false)); else for (const d of [].concat(dev)) await lab.simctl({ cmd: 'fault', dev: d, f, on: false });
    const end = Date.now();
    for (const x of lab.faults.filter(x => x.why === name)) x.to = end;
    await sleep(20000);
    const g = lab.gaps(t, Date.now()).filter(x => !noGapsFor || noGapsFor(x.point));
    const w = wrongValues(lab, t);
    assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 4))}`);
    assert(!w.bad.length, `${w.bad.length} wrong values: ${JSON.stringify(w.bad.slice(0, 3))}`);
    return { gaps: 0, values_checked: w.checked };
  }, lab);
}

async function mainStage() {
  const lab = new Lab({ kind: 'modbus', net: 'bas-mb', prefix: '10.78.0', ips: 30, webPort: 18774, ignorePoint: ERROR_POINTS,
    mb: { tcp: 6, gateways: 1, perGateway: 8, rtuOverTcp: 4, serial: 6, baud: 19200, tiny: true } });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const N = lab.simInfo.devices.length;
  let T0;
  try {
    await test('baseline: every device and point read on every connection type', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 120000, 'scan');
      assert(st.scan.last_result.devices === N, `found ${st.scan.last_result.devices} of ${N}`);
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0')[0].n;
      const good = lab.q('SELECT key FROM points WHERE missing=0').filter(p => !ERROR_POINTS(p.key)).length;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === good, 180000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { devices: N, points: pts };
    }, lab);

    await test('every value decodes correctly (all types, word orders, scaling, bits)', async () => {
      const w = wrongValues(lab);
      assert(w.checked > N * 30, `only ${w.checked} values checked`);
      assert(!w.bad.length, `${w.bad.length} wrong: ${JSON.stringify(w.bad.slice(0, 5))}`);
      const errs = lab.q("SELECT p.name, p.last_error FROM points p WHERE p.last_error IS NOT NULL");
      const unexpected = errs.filter(e => !['nan', 'not-available'].includes(e.name));
      assert(!unexpected.length, `unexpected point errors: ${JSON.stringify(unexpected.slice(0, 4))}`);
      assert(errs.length === 2 * N, `${errs.length} error points, expected ${2 * N} (NaN and not-available on each device)`);
      return { values_checked: w.checked, error_points: errs.length };
    }, lab);

    await test('TCP device powered off (half-open connection), then back on', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'tcp-03', f: 'offline', on: true }); lab.fault(K('tcp-03'), t, null, 'off');
      await lab.waitFor(() => status(lab, 'tcp-03') === 'offline', 120000, 'offline');
      await sleep(30000);
      await lab.simctl({ cmd: 'fault', dev: 'tcp-03', f: 'offline', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('tcp-03')) > back, 90000, 'readings after power on');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((lastRead(lab, K('tcp-03')) - back) / 1000) };
    }, lab);

    await test('TCP device reboots (20 s, forgets the connection)', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'tcp-04', f: 'reboot', v: 20 }); lab.fault(K('tcp-04'), t, t + 20000, 'reboot');
      await sleep(25000);
      await lab.waitFor(() => lastRead(lab, K('tcp-04')) > t + 20000, 90000, 'readings after reboot');
      await sleep(15000);
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((lastRead(lab, K('tcp-04')) - t - 20000) / 1000) };
    }, lab);

    await test('device behind the gateway stops answering (gateway reports it)', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'gw1-u03', f: 'offline', on: true }); lab.fault(K('gw1-u03'), t, null, 'off');
      await lab.waitFor(() => status(lab, 'gw1-u03') === 'offline', 120000, 'offline');
      await sleep(30000);
      await lab.simctl({ cmd: 'fault', dev: 'gw1-u03', f: 'offline', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('gw1-u03')) > back, 90000, 'readings after power on');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps (other gateway devices must not suffer): ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    }, lab);

    await test('whole gateway powered off 60 s', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'gw1', f: 'offline', on: true });
      const gw = lab.simInfo.devices.filter(d => d.conn.name === 'gw1').map(d => K(d.name));
      for (const k of gw) lab.fault(k, t, null, 'gw off');
      await sleep(60000);
      await lab.simctl({ cmd: 'fault', dev: 'gw1', f: 'offline', on: false });
      const back = Date.now(); for (const x of lab.faults.filter(x => x.why === 'gw off')) x.to = back;
      await lab.waitFor(() => gw.every(k => lastRead(lab, k) > back), 120000, 'all gateway devices back');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((Math.max(...gw.map(k => lastRead(lab, k))) - back) / 1000) };
    }, lab);

    await test('RTU device on the RS-485 bus powered off, then back on', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'rtu-u03', f: 'offline', on: true }); lab.fault(K('rtu-u03'), t, null, 'off');
      await lab.waitFor(() => status(lab, 'rtu-u03') === 'offline', 120000, 'offline');
      await sleep(30000);
      await lab.simctl({ cmd: 'fault', dev: 'rtu-u03', f: 'offline', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('rtu-u03')) > back, 90000, 'readings after power on');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps (other bus devices must not suffer): ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    }, lab);

    await faultTest(lab, 'light electrical noise on the RS-485 bus (5 bytes/s)', { sim: on => ({ cmd: 'bus', noise: on ? 5 : 0 }) });
    await faultTest(lab, '0.05% of bytes lost on the RS-485 bus', { sim: on => ({ cmd: 'bus', drop: on ? 0.0005 : 0 }) });

    await test('box serial cable pulled for 60 s', async () => {
      const t = Date.now();
      const rtu = lab.simInfo.devices.filter(d => d.conn.type === 'rtu').map(d => K(d.name));
      await lab.simctl({ cmd: 'bus', cut: 0, on: true }); for (const k of rtu) lab.fault(k, t, null, 'cable');
      await sleep(60000);
      await lab.simctl({ cmd: 'bus', cut: 0, on: false });
      const back = Date.now(); for (const x of lab.faults.filter(x => x.why === 'cable')) x.to = back;
      await lab.waitFor(() => rtu.every(k => lastRead(lab, k) > back), 120000, 'bus devices back');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((Math.max(...rtu.map(k => lastRead(lab, k))) - back) / 1000) };
    }, lab);

    await test('a second Modbus master appears on the RS-485 bus: box stands back, no wrong values', async () => {
      const t = Date.now();
      const rtu = lab.simInfo.devices.filter(d => d.conn.type === 'rtu').map(d => K(d.name));
      await lab.simctl({ cmd: 'master', on: true }); for (const k of rtu) lab.fault(k, t, null, 'second master');
      await lab.waitFor(() => rtu.every(k => status(lab, k.slice(9)) === 'offline'), 180000, 'bus devices offline');
      const msg = lab.q("SELECT last_error FROM devices WHERE key=?", rtu[0])[0].last_error || '';
      await lab.simctl({ cmd: 'master', on: false });
      const back = Date.now(); for (const x of lab.faults.filter(x => x.why === 'second master')) x.to = back + 90000;
      await lab.waitFor(() => rtu.every(k => lastRead(lab, k) > back), 240000, 'bus devices back after the other master left');
      const w = wrongValues(lab, t);
      assert(/another Modbus master/.test(msg), `device error was: ${msg}`);
      assert(!w.bad.length, `${w.bad.length} wrong values while two masters shared the bus`);
      return { error_shown: msg.slice(0, 80), back_after_s: Math.round((Math.max(...rtu.map(k => lastRead(lab, k))) - back) / 1000) };
    }, lab);

    await faultTest(lab, 'slow replies (1.5 s each)', { dev: ['tcp-05', 'gw1-u05'], f: 'slow', v: 1.5 });
    await faultTest(lab, '15% of requests never answered', { dev: ['tcp-05', 'gw1-u06', 'rs1-u02', 'rtu-u02'], f: 'drop', v: 0.15 });
    await faultTest(lab, '20% "device busy" replies', { dev: ['tcp-06', 'gw1-u07', 'rtu-u04'], f: 'busy', v: 0.2 });
    await faultTest(lab, '10% garbage replies', { dev: ['tcp-01', 'gw1-u02', 'rs1-u03', 'rtu-u05'], f: 'garbage', v: 0.1 });
    await faultTest(lab, '30% of replies preceded by a stale earlier reply', { dev: ['tcp-02', 'gw1'], f: 'stale', v: 0.3 });
    await faultTest(lab, 'replies arrive in pieces', { dev: ['tcp-03', 'rs1'], f: 'partial', v: 1 });
    await faultTest(lab, 'device closes the connection after 30% of replies', { dev: ['tcp-04', 'gw1', 'rs1'], f: 'close', v: 0.3 });
    await faultTest(lab, '10% replies from the wrong unit id', { dev: ['tcp-06', 'gw1-u01', 'rs1-u04'], f: 'wrongunit', v: 0.1 });

    await test('5% TCP packet loss on the network for 2 min', async () => {
      const t = Date.now();
      lab.lossOn(0.05);
      await sleep(120000);
      lab.lossOff();
      await sleep(20000);
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    }, lab);

    await test('RTU-over-TCP serial server powered off 60 s', async () => {
      const t = Date.now();
      const rs = lab.simInfo.devices.filter(d => d.conn.name === 'rs1').map(d => K(d.name));
      await lab.simctl({ cmd: 'fault', dev: 'rs1', f: 'offline', on: true }); for (const k of rs) lab.fault(k, t, null, 'rs off');
      await sleep(60000);
      await lab.simctl({ cmd: 'fault', dev: 'rs1', f: 'offline', on: false });
      const back = Date.now(); for (const x of lab.faults.filter(x => x.why === 'rs off')) x.to = back;
      await lab.waitFor(() => rs.every(k => lastRead(lab, k) > back), 120000, 'all back');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((Math.max(...rs.map(k => lastRead(lab, k))) - back) / 1000) };
    }, lab);

    await test('driver killed mid-read', async () => {
      const t = Date.now();
      lab.killDriver(); lab.fault('*', t, null, 'driver killed');
      await lab.waitFor(() => lab.simInfo.devices.every(d => lastRead(lab, K(d.name)) > t + 3000), 90000, 'readings resume');
      lab.faults.at(-1).to = Date.now();
      return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('box killed (power loss) and restarted', async () => {
      const t = Date.now();
      await lab.stopBox('SIGKILL'); lab.fault('*', t, null, 'box killed');
      await sleep(10000);
      await lab.startBox();
      await lab.waitFor(() => lab.simInfo.devices.every(d => lastRead(lab, K(d.name)) > t + 10000), 120000, 'readings after restart');
      lab.faults.at(-1).to = Date.now();
      return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('request rate per device stays under the limit', async () => {
      const st = await lab.simctl({ cmd: 'stats' });
      const worst = Object.entries(st.devices).sort((a, b) => b[1].max_rate - a[1].max_rate)[0];
      const gw = Object.entries(st.servers).map(([n, s]) => [n, s.max_inflight]);
      assert(worst[1].max_rate <= 12, `${worst[0]} got ${worst[1].max_rate} requests in one second`);
      return { busiest: worst[0], max_per_s: worst[1].max_rate, gateway_inflight: gw };
    }, lab);

    await test('whole run: no unexplained gaps, no wrong values, nothing lost', async () => {
      const g = lab.gaps(T0, Date.now() - 20000);
      const w = wrongValues(lab);
      const l = await lab.lossCheck();
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 5))}`);
      assert(!w.bad.length, `${w.bad.length} wrong values`);
      assert(l.missing === 0 && l.duplicates === 0 && l.extra === 0, JSON.stringify(l));
      return { ...l, values_checked: w.checked };
    }, lab);
  } finally { await lab.close(); }
}

// The driver must survive bad settings and missing hardware: good devices keep working.
async function configStage() {
  const lab = new Lab({ kind: 'modbus', net: 'bas-mb2', prefix: '10.78.1', ips: 10, mb: { tcp: 2, gateways: 0, rtuOverTcp: 0, serial: 0 } });
  await lab.startSim();
  const drv = () => {
    const p = spawn('python3', [path.join(ROOT, 'drivers', 'modbus', 'driver.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    const msgs = []; let buf = '';
    p.stdout.on('data', d => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) if (l) msgs.push(JSON.parse(l)); });
    let id = 0;
    const call = async (op, args = {}, ms = 30000) => {
      const my = ++id; p.stdin.write(JSON.stringify({ id: my, op, ...args }) + '\n');
      await lab.waitFor(() => msgs.some(m => m.id === my && !m.event), ms, op, 100);
      return { reply: msgs.find(m => m.id === my && !m.event), events: msgs.filter(m => m.id === my && m.event) };
    };
    return { p, call };
  };
  try {
    await test('bad settings: warnings, good devices still read', async () => {
      const good = lab.simInfo.devices[0];
      const tpl = lab.mbTemplates.meter.points;
      const s = {
        connections: [good.conn, { name: 'c-bad', type: 'carrier-pigeon' }, { name: good.conn.name, type: 'tcp', host: 'x' },
          { name: 'c-noport', type: 'rtu', serial: '/dev/ttyDOESNOTEXIST' }, { name: 'c-dead', type: 'tcp', host: '10.78.1.99', port: 502, timeout_ms: 500 }],
        templates: { meter: { points: tpl } },
        devices: [
          { name: 'ok', connection: good.conn.name, unit: 1, template: 'meter', points: [{ name: 'bad-type', address: 5, type: 'f128' }, { name: 'bad-reg', register: 99999 }] },
          { name: 'no conn', connection: good.conn.name },
          { name: 'noconn', connection: 'nope' },
          { name: 'notpl', connection: good.conn.name, template: 'nope' },
          { name: 'ok', connection: good.conn.name },
          { name: 'noport', connection: 'c-noport', unit: 1, template: 'meter' },
          { name: 'dead', connection: 'c-dead', unit: 1, template: 'meter' },
        ],
      };
      const d = drv();
      try {
        const c = await d.call('configure', { settings: s });
        assert(c.reply.ok, JSON.stringify(c.reply));
        const w = c.reply.result.warnings;
        assert(w.length >= 7, `only ${w.length} warnings: ${w.join('; ')}`);
        const disc = await d.call('discover');
        const devs = disc.events.filter(e => e.event === 'device').map(e => e.data);
        assert(devs.length === 3, `${devs.length} devices: ${devs.map(x => x.name)}`);
        const byName = Object.fromEntries(devs.map(x => [x.name, x]));
        const br = await d.call('browse', { device: byName.ok });
        const keys = br.events.map(e => e.data.key);
        assert(keys.length === tpl.length, `${keys.length} points`);
        const r = await d.call('read', { device: byName.ok, points: [...keys, 'modbus://ok/holding:banana', 'garbage'] });
        assert(r.reply.ok, JSON.stringify(r.reply));
        const bad = r.reply.result.values.filter(v => v.error && !/NaN|no data|not a valid/.test(v.error));
        assert(!bad.length, JSON.stringify(bad.slice(0, 3)));
        const np = await d.call('read', { device: byName.noport, points: keys.slice(0, 3).map(k => k.replace('//ok/', '//noport/')) });
        assert(!np.reply.ok && np.reply.error.code === 'unreachable', JSON.stringify(np.reply));
        const t = Date.now();
        const dead = await d.call('read', { device: byName.dead, points: keys.slice(0, 3).map(k => k.replace('//ok/', '//dead/')) });
        assert(!dead.reply.ok && ['unreachable', 'timeout'].includes(dead.reply.error.code), JSON.stringify(dead.reply));
        const gone = await d.call('read', { device: { key: 'modbus://removed' }, points: [] });
        assert(!gone.reply.ok && gone.reply.error.code === 'bad_request', JSON.stringify(gone.reply));
        const again = await d.call('read', { device: byName.ok, points: keys.slice(0, 5) });
        assert(again.reply.ok, 'good device stopped working');
        return { warnings: w.length, devices: devs.length, dead_read_s: Math.round((Date.now() - t) / 100) / 10 };
      } finally { d.p.kill('SIGKILL'); }
    }, lab);

    await test('device allowing one connection, and the driver restarting against it', async () => {
      await lab.simctl({ cmd: 'fault', dev: 'tcp-02', f: 'maxconn', v: 1 });
      const dev = lab.simInfo.devices[1];
      const s = { connections: [dev.conn], templates: { meter: { points: lab.mbTemplates.meter.points } }, devices: [{ name: 'one', connection: dev.conn.name, unit: 1, template: 'meter' }] };
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        const d = drv();
        try {
          await d.call('configure', { settings: s });
          const disc = await d.call('discover');
          const one = disc.events[0].data;
          const br = await d.call('browse', { device: one });
          const r = await d.call('read', { device: one, points: br.events.map(e => e.data.key) });
          if (r.reply.ok) ok++;
        } finally { d.p.kill('SIGKILL'); }
      }
      assert(ok === 5, `${ok} of 5 driver starts could read`);
      return { reads_ok: ok };
    }, lab);
  } finally { await lab.close(); }
}

async function bigStage() {
  const lab = new Lab({ kind: 'modbus', net: 'bas-mb3', prefix: '10.78.2', ips: 220, interval: 60, webPort: 18775, ignorePoint: ERROR_POINTS,
    mb: { tcp: 200, gateways: 5, perGateway: 30, rtuOverTcp: 10, serial: 20, baud: 9600, big: true } });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const N = lab.simInfo.devices.length;
  try {
    await test(`large site: ${N} Modbus devices (200 TCP, 5 gateways x 30, 20 on a 9600 baud bus)`, async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 600000, 'scan', 5000);
      assert(st.scan.last_result.devices === N, `found ${st.scan.last_result.devices} of ${N}`);
      const good = lab.q('SELECT key FROM points WHERE missing=0').filter(p => !ERROR_POINTS(p.key)).length;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=2)')[0].n === good, 600000, 'every point read twice', 5000);
      const T0 = Date.now();
      await sleep(300000);
      const g = lab.gaps(T0, Date.now());
      const w = wrongValues(lab);
      const s2 = await lab.boxStatus();
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      assert(!w.bad.length, `${w.bad.length} wrong values`);
      return { devices: N, points: good, values_checked: w.checked, lanes_behind: s2.health.lanes_behind };
    }, lab);
  } finally { await lab.close(); }
}

(async () => {
  const t = Date.now();
  if (STAGES.has('main')) await mainStage();
  if (STAGES.has('config')) await configStage();
  if (STAGES.has('big')) await bigStage();
  const pass = results.filter(r => r.pass).length;
  console.log(`\n${pass} of ${results.length} Modbus fault tests passed in ${Math.round((Date.now() - t) / 60000)} min`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
