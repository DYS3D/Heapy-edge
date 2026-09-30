'use strict';
// Shared pieces of the fault suites: test runner, report, common checks.
const fs = require('node:fs');
const { sleep } = require('./lab');

function kit(title, out) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
  const OUT = arg('out', out);
  const results = [];
  const t0 = Date.now();
  const assert = (c, m) => { if (!c) throw new Error(m); };
  async function test(name, fn) {
    if (ONLY && !ONLY.has(name)) return;
    const t = Date.now();
    console.log(`\n▶ ${name}`);
    try {
      const d = await fn() || {};
      results.push({ name, pass: true, secs: Math.round((Date.now() - t) / 1000), detail: d });
      console.log(`  ✔ ${name} (${Math.round((Date.now() - t) / 1000)} s) ${JSON.stringify(d).slice(0, 300)}`);
    } catch (e) {
      results.push({ name, pass: false, error: e.message });
      console.log(`  ✘ ${name}: ${e.message}`);
    }
  }
  function finish() {
    const pass = results.filter(r => r.pass).length;
    console.log(`\n${pass} of ${results.length} ${title} fault tests passed in ${Math.round((Date.now() - t0) / 60000)} min`);
    fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
    process.exit(pass === results.length ? 0 : 1);
  }
  return { arg, test, assert, finish, results };
}

const lastRead = (lab, k) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, k)[0].t || 0;
const lastPointRead = (lab, k) => lab.q('SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p WHERE p.key=?', k)[0].t || 0;
const status = (lab, key) => (lab.device(key) || {}).status;

// Stored readings must equal the served value: faults may cost readings, never make wrong ones.
// expectFor(row) -> expected value (number), 'range:lo:hi', 'any', null (must not be stored) or undefined (skip)
function wrongValues(lab, expectFor, since = 0) {
  const rows = lab.q(`SELECT p.key, p.name, p.description, d.key dkey, s.v FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE s.t>=?`, since);
  const bad = []; let checked = 0;
  for (const r of rows) {
    const w = expectFor(r);
    if (w === undefined || w === 'any') continue;
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

// Standard sequence for a device-level fault: set it for `secs`, clear it, then no gaps and no wrong values.
async function faultWindow(lab, { devs, f, v = true, secs = 120, expectFor, assert }) {
  const t = Date.now();
  for (const d of devs) await lab.simctl({ cmd: 'fault', dev: d, f, v, on: true });
  await sleep(secs * 1000);
  for (const d of devs) await lab.simctl({ cmd: 'fault', dev: d, f, on: false });
  await sleep(20000);
  const g = lab.gaps(t, Date.now());
  const w = wrongValues(lab, expectFor, t);
  assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 4))}`);
  assert(!w.bad.length, `${w.bad.length} wrong values: ${JSON.stringify(w.bad.slice(0, 3))}`);
  return { gaps: 0, values_checked: w.checked };
}

// Device powered off (or hung) for a while: goes offline, others unaffected, back after.
async function outage(lab, { dev, key, f = 'offline', secs = 30, waitOffline = true, assert }) {
  const t = Date.now();
  await lab.simctl({ cmd: 'fault', dev, f, on: true }); lab.fault(key, t, null, `${f} ${dev}`);
  if (waitOffline) await lab.waitFor(() => status(lab, key) === 'offline', 120000, 'offline');
  await sleep(secs * 1000);
  await lab.simctl({ cmd: 'fault', dev, f, on: false });
  const back = Date.now(); lab.faults.at(-1).to = back;
  await lab.waitFor(() => lastRead(lab, key) > back, 120000, 'readings again');
  const g = lab.gaps(t, Date.now());
  assert(!g.length, `${g.length} gaps (other devices must not suffer): ${JSON.stringify(g.slice(0, 3))}`);
  return { back_after_s: Math.round((lastRead(lab, key) - back) / 1000) };
}

async function commonTail(lab, { test, assert, keys, expectFor, T0, rateMax }) {
  await test('driver killed mid-read', async () => {
    const t = Date.now();
    lab.killDriver(); lab.fault('*', t, null, 'driver killed');
    await lab.waitFor(() => keys.every(k => lastRead(lab, k) > t + 3000), 90000, 'readings resume');
    lab.faults.at(-1).to = Date.now();
    return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
  });
  await test('box killed (power loss) and restarted', async () => {
    const t = Date.now();
    await lab.stopBox('SIGKILL'); lab.fault('*', t, null, 'box killed');
    await sleep(10000);
    await lab.startBox();
    await lab.waitFor(() => keys.every(k => lastRead(lab, k) > t + 10000), 120000, 'readings after restart');
    lab.faults.at(-1).to = Date.now();
    return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
  });
  if (rateMax) {
    await test('requests per server stay under the limit, one connection each', async () => {
      const st = (await lab.simctl({ cmd: 'stats' })).servers;
      const worst = Object.entries(st).sort((a, b) => b[1].max_rate - a[1].max_rate)[0];
      const conns = Math.max(...Object.values(st).map(s => s.max_conns));
      assert(worst[1].max_rate <= rateMax, `${worst[0]} got ${worst[1].max_rate} requests in one second`);
      assert(conns <= 2, `${conns} connections at once`);
      return { busiest: worst[0], max_per_s: worst[1].max_rate, max_conns: conns };
    });
  }
  await test('whole run: no unexplained gaps, no wrong values, nothing lost', async () => {
    const g = lab.gaps(T0(), Date.now() - 20000);
    const w = wrongValues(lab, expectFor);
    const l = await lab.lossCheck();
    assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 5))}`);
    assert(!w.bad.length, `${w.bad.length} wrong values`);
    assert(l.missing === 0 && l.duplicates === 0 && l.extra === 0, JSON.stringify(l));
    return { ...l, values_checked: w.checked };
  });
}

module.exports = { kit, lastRead, lastPointRead, status, wrongValues, faultWindow, outage, commonTail };
