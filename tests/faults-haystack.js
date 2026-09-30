'use strict';
// HEAPY Edge fault tests for the Project Haystack driver (Linux root).
// Simulated Haystack servers: SCRAM-SHA-256 login, basic login and no login;
// JSON v3 and v4. Faults hit the servers, logins, the network, the driver and the box.
//   node tests/faults-haystack.js [--only "a|b"] [--out file]
const fs = require('node:fs');
const path = require('node:path');
const { Lab, sleep, ROOT } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
const OUT = arg('out', path.join(ROOT, 'fault-report-haystack.json'));
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
const K = n => `haystack://${n}`;
const lastRead = (lab, k) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, k)[0].t || 0;
const status = (lab, n) => (lab.device(K(n)) || {}).status;
const ERR = /\.(bad|nan|noval)$/;

function wrongValues(lab, since = 0) {
  const exp = lab.hsExpected;
  const rows = lab.q(`SELECT p.name, s.v FROM samples s JOIN points p ON p.id=s.p WHERE s.t>=?`, since);
  const bad = []; let checked = 0;
  for (const r of rows) {
    const w = exp[r.name];
    if (w === undefined) continue;
    if (w === null) { bad.push(r); continue; }
    if (typeof w === 'string') {
      if (w.startsWith('range:')) { const [, lo, hi] = w.split(':').map(Number); checked++; if (!(r.v >= lo && r.v <= hi)) bad.push(r); }
      continue;
    }
    checked++;
    if (Math.abs(r.v - w) > Math.abs(w) * 1e-9) bad.push(r);
  }
  return { checked, bad };
}

async function faultTest(lab, name, { dev, f, v = true, secs = 120 }) {
  return test(name, async () => {
    const t = Date.now();
    for (const d of [].concat(dev)) await lab.simctl({ cmd: 'fault', dev: d, f, v, on: true });
    await sleep(secs * 1000);
    for (const d of [].concat(dev)) await lab.simctl({ cmd: 'fault', dev: d, f, on: false });
    await sleep(20000);
    const g = lab.gaps(t, Date.now());
    const w = wrongValues(lab, t);
    assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 4))}`);
    assert(!w.bad.length, `${w.bad.length} wrong values: ${JSON.stringify(w.bad.slice(0, 3))}`);
    return { gaps: 0, values_checked: w.checked };
  }, lab);
}

(async () => {
  const t0 = Date.now();
  const lab = new Lab({ kind: 'haystack', net: 'bas-hs', prefix: '10.78.6', ips: 8, servers: 4, webPort: 18777, ignorePoint: k => ERR.test(k) });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const N = lab.simInfo.devices.length;
  let T0;
  try {
    await test('baseline: every server (SCRAM, basic, no login; JSON v3 and v4) and point read', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 120000, 'scan');
      assert(st.scan.last_result.devices === N, `found ${st.scan.last_result.devices} of ${N}`);
      const good = lab.q('SELECT key FROM points WHERE missing=0').filter(p => !ERR.test(p.key)).length;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === good, 180000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { servers: N, points: good };
    }, lab);

    await test('every value correct (numbers with units, bools, enums, text numbers; faults reported)', async () => {
      const w = wrongValues(lab);
      assert(w.checked > N * 60, `only ${w.checked} checked`);
      assert(!w.bad.length, `${w.bad.length} wrong: ${JSON.stringify(w.bad.slice(0, 5))}`);
      const errs = lab.q('SELECT key, last_error FROM points WHERE last_error IS NOT NULL');
      assert(errs.length === 3 * N && errs.every(e => ERR.test(e.key)), JSON.stringify(errs.slice(0, 5)));
      return { values_checked: w.checked, error_points: errs.length };
    }, lab);

    await test('server powered off 60 s, then back', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'hs-01', f: 'offline', on: true }); lab.fault(K('hs-01'), t, null, 'off');
      await lab.waitFor(() => status(lab, 'hs-01') === 'offline', 120000, 'offline');
      await sleep(30000);
      await lab.simctl({ cmd: 'fault', dev: 'hs-01', f: 'offline', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('hs-01')) > back, 90000, 'readings again');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((lastRead(lab, K('hs-01')) - back) / 1000) };
    }, lab);

    await test('server stops answering (hung) 40 s', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'hs-02', f: 'hang', on: true }); lab.fault(K('hs-02'), t, null, 'hang');
      await sleep(40000);
      await lab.simctl({ cmd: 'fault', dev: 'hs-02', f: 'hang', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('hs-02')) > back, 120000, 'readings again');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { back_after_s: Math.round((lastRead(lab, K('hs-02')) - back) / 1000) };
    }, lab);

    await faultTest(lab, 'slow replies (2 s)', { dev: ['hs-01', 'hs-03'], f: 'slow', v: 2 });
    await faultTest(lab, '15% HTTP 500 errors', { dev: ['hs-01', 'hs-02'], f: 'err500', v: 0.15 });
    await faultTest(lab, '10% broken JSON replies', { dev: ['hs-02', 'hs-04'], f: 'garbage', v: 0.1 });
    await faultTest(lab, '15% of connections dropped without a reply', { dev: ['hs-01', 'hs-03', 'hs-04'], f: 'drop', v: 0.15 });
    await faultTest(lab, '15% "busy" (HTTP 429) replies', { dev: ['hs-02', 'hs-03'], f: 'busy', v: 0.15 });

    await test('login tokens thrown away by the server every 30 s', async () => {
      const t = Date.now();
      const before = (await lab.simctl({ cmd: 'stats' })).servers;
      for (let i = 0; i < 4; i++) { await lab.simctl({ cmd: 'fault', dev: 'hs-01', f: 'expire' }); await lab.simctl({ cmd: 'fault', dev: 'hs-02', f: 'expire' }); await sleep(30000); }
      await sleep(20000);
      const after = (await lab.simctl({ cmd: 'stats' })).servers;
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      const logins = after['hs-01'].logins - before['hs-01'].logins;
      assert(logins >= 3, `only ${logins} new logins`);
      return { new_logins: logins };
    }, lab);

    await test('a point goes into fault, then recovers; other points unaffected', async () => {
      const t = Date.now();
      const key = K('hs-03') + '/p:hs-03:ahu2.sat';
      await lab.simctl({ cmd: 'fault', dev: 'hs-03', f: 'status', v: 'ahu2.sat', on: true }); lab.fault(key, t, null, 'point fault');
      await lab.waitFor(() => (lab.q('SELECT last_error FROM points WHERE key=?', key)[0] || {}).last_error === 'point status fault', 60000, 'point error shown');
      await lab.simctl({ cmd: 'fault', dev: 'hs-03', f: 'status', v: 'ahu2.sat', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lab.q('SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p WHERE p.key=?', key)[0].t > back, 60000, 'point back');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      assert(status(lab, 'hs-03') === 'online', 'server marked down for one point');
      return {};
    }, lab);

    await test('5% TCP packet loss on the network for 2 min', async () => {
      const t = Date.now();
      lab.lossOn(0.05, 'tcp');
      await sleep(120000);
      lab.lossOff();
      await sleep(20000);
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return {};
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

    await test('requests per server stay under the limit, one connection each', async () => {
      const st = (await lab.simctl({ cmd: 'stats' })).servers;
      const worst = Object.entries(st).sort((a, b) => b[1].max_rate - a[1].max_rate)[0];
      const conns = Math.max(...Object.values(st).map(s => s.max_conns));
      assert(worst[1].max_rate <= 8, `${worst[0]} got ${worst[1].max_rate} requests in one second`);
      assert(conns <= 2, `${conns} connections at once`);
      return { busiest: worst[0], max_per_s: worst[1].max_rate, max_conns: conns };
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
  const pass = results.filter(r => r.pass).length;
  console.log(`\n${pass} of ${results.length} Haystack fault tests passed in ${Math.round((Date.now() - t0) / 60000)} min`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
