'use strict';
// HEAPY Edge fault tests for the SNMP driver (Linux root).
// Simulated UPS agents: v2c and v1 agents written for the lab (faults injected per
// reply) and a v3 authPriv agent (snmpsim). Faults hit the agents, the network,
// the driver and the box.
//   node tests/faults-snmp.js [--only "a|b"] [--out file]
const fs = require('node:fs');
const path = require('node:path');
const { Lab, sleep, ROOT } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
const OUT = arg('out', path.join(ROOT, 'fault-report-snmp.json'));
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
const K = n => `snmp://${n}`;
const lastRead = (lab, k) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, k)[0].t || 0;
const status = (lab, n) => (lab.device(K(n)) || {}).status;

function errorPoint(lab) {
  const v1 = new Set(lab.simInfo.devices.filter(d => d.version === '1').map(d => K(d.name)));
  const extra = Object.fromEntries(lab.snmpExpected.extra_points.map(p => [p.oid, p.name]));
  return key => {
    const [dkey, oid] = [key.split('/').slice(0, 3).join('/'), key.split('/').slice(3).join('/')];
    const n = extra[oid];
    return n === 'text-word' || n === 'missing' || (n === 'counter64' && v1.has(dkey));
  };
}

function wrongValues(lab, since = 0) {
  const exp = lab.snmpExpected.expected;
  const v3 = new Set(lab.simInfo.devices.filter(d => d.static).map(d => K(d.name)));
  const rows = lab.q(`SELECT p.name, d.key dkey, s.v FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE s.t>=?`, since);
  const bad = []; let checked = 0;
  for (const r of rows) {
    let w = exp[r.name];
    if (w === undefined) continue;
    if (r.name === 'Output load' && v3.has(r.dkey)) w = 30;
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

async function outage(lab, name, dev, f, secs) {
  return test(name, async () => {
    const t = Date.now();
    await lab.simctl({ cmd: 'fault', dev, f, v: f === 'reboot' ? secs : true, on: true }); lab.fault(K(dev), t, null, name);
    if (f === 'reboot') await sleep(secs * 1000 + 3000);
    else {
      await lab.waitFor(() => status(lab, dev) === 'offline', 120000, 'offline');
      await sleep(secs * 1000);
      await lab.simctl({ cmd: 'fault', dev, f, on: false });
    }
    const back = Date.now(); lab.faults.at(-1).to = back;
    await lab.waitFor(() => lastRead(lab, K(dev)) > back, 90000, 'readings again');
    await sleep(5000);
    const g = lab.gaps(t, Date.now());
    assert(!g.length, `${g.length} gaps (other devices must not suffer): ${JSON.stringify(g.slice(0, 3))}`);
    return { back_after_s: Math.round((lastRead(lab, K(dev)) - back) / 1000) };
  }, lab);
}

(async () => {
  const t0 = Date.now();
  const lab = new Lab({ kind: 'snmp', net: 'bas-snmp', prefix: '10.78.5', ips: 12, webPort: 18776, snmp: { agents: 6, v3: true } });
  await lab.startSim();
  lab.o.ignorePoint = errorPoint(lab);
  await lab.startServer(); await lab.startBox();
  const N = lab.simInfo.devices.length;
  let T0;
  try {
    await test('baseline: every agent (v1, v2c, v3 authPriv) and point read', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 120000, 'scan');
      assert(st.scan.last_result.devices === N, `found ${st.scan.last_result.devices} of ${N}`);
      const good = lab.q('SELECT key FROM points WHERE missing=0').filter(p => !lab.o.ignorePoint(p.key)).length;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === good, 180000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { agents: N, points: good };
    }, lab);

    await test('every value correct (scaling, text numbers, 64-bit counters, missing objects)', async () => {
      const w = wrongValues(lab);
      assert(w.checked > N * 40, `only ${w.checked} checked`);
      assert(!w.bad.length, `${w.bad.length} wrong: ${JSON.stringify(w.bad.slice(0, 5))}`);
      const errs = lab.q('SELECT p.name, p.last_error FROM points p WHERE p.last_error IS NOT NULL');
      const odd = errs.filter(e => !['text-word', 'missing', 'counter64'].includes(e.name));
      assert(!odd.length, `unexpected point errors: ${JSON.stringify(odd.slice(0, 4))}`);
      return { values_checked: w.checked, error_points: errs.length };
    }, lab);

    await outage(lab, 'agent powered off 30 s, then back', 'ups-02', 'offline', 30);
    await outage(lab, 'agent reboots (20 s, uptime restarts)', 'ups-04', 'reboot', 20);
    await faultTest(lab, '15% of requests never answered', { dev: ['ups-01', 'ups-03', 'ups-05'], f: 'drop', v: 0.15 });
    await faultTest(lab, 'slow replies (0.8 s)', { dev: ['ups-02', 'ups-06'], f: 'slow', v: 0.8 });
    await faultTest(lab, '10% garbage replies', { dev: ['ups-01', 'ups-03'], f: 'garbage', v: 0.1 });
    await faultTest(lab, '30% of replies preceded by a stale earlier reply', { dev: ['ups-02', 'ups-03'], f: 'stale', v: 0.3 });
    await faultTest(lab, '30% of replies sent twice', { dev: ['ups-04', 'ups-06'], f: 'dup', v: 0.3 });
    await faultTest(lab, 'agent takes at most 5 objects per request (tooBig)', { dev: ['ups-01', 'ups-03'], f: 'toobig', v: 5 });
    await faultTest(lab, '10% genErr replies', { dev: ['ups-05', 'ups-06'], f: 'generr', v: 0.1 });

    await test('community changed on the agent: device reported offline, back when fixed', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'fault', dev: 'ups-05', f: 'community', v: 'changed', on: true }); lab.fault(K('ups-05'), t, null, 'community');
      await lab.waitFor(() => status(lab, 'ups-05') === 'offline', 120000, 'offline');
      await lab.simctl({ cmd: 'fault', dev: 'ups-05', f: 'community', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('ups-05')) > back, 90000, 'readings again');
      return {};
    }, lab);

    await test('5% UDP packet loss on the network for 2 min', async () => {
      const t = Date.now();
      lab.lossOn(0.05, 'udp');
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

    await test('request rate per agent stays under the limit', async () => {
      const st = await lab.simctl({ cmd: 'stats' });
      const worst = Object.entries(st.devices).sort((a, b) => b[1].max_rate - a[1].max_rate)[0];
      assert(worst[1].max_rate <= 7, `${worst[0]} got ${worst[1].max_rate} requests in one second`);
      return { busiest: worst[0], max_per_s: worst[1].max_rate };
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
  console.log(`\n${pass} of ${results.length} SNMP fault tests passed in ${Math.round((Date.now() - t0) / 60000)} min`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
