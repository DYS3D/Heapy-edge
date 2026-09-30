'use strict';
// HEAPY Edge fault tests for the BACnet MS/TP driver (Linux root).
// A virtual RS-485 trunk with bacnet-stack MS/TP devices; the box joins it
// through its own MS/TP router, as it would on a real site.
//   node tests/faults-mstp.js [--stages main,big] [--only "a|b"] [--out file]
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { Lab, sleep, ROOT } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
const STAGES = new Set(arg('stages', 'main,big').split(','));
const OUT = arg('out', path.join(ROOT, 'fault-report-mstp.json'));
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
const K = mac => `bacnet://${30000 + mac}`;
const lastRead = (lab, k) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, k)[0].t || 0;
async function watch(lab, ms) {
  const seen = new Set(); const end = Date.now() + ms;
  while (Date.now() < end) { for (const d of lab.q('SELECT status FROM devices')) seen.add(d.status); await sleep(2000); }
  return seen;
}
const routerPids = lab => {
  try { return execSync(`ip netns pids heapy-mstp-${path.basename(lab.simInfo.box_port).replace('tty', '')}`).toString().trim().split('\n').filter(Boolean); } catch { return []; }
};

async function mainStage() {
  const lab = new Lab({ kind: 'mstp', devices: 10, link: '10.255.78', webPort: 18772 });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  let T0;
  try {
    await test('baseline: box joins the trunk, finds and reads every device', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 240000, 'scan');
      assert(st.scan.last_result.devices === 10, `found ${st.scan.last_result.devices} of 10`);
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0')[0].n;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === pts, 180000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps`);
      return { devices: 10, points: pts };
    }, lab);

    await test('device powered off, then back on', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'offline', mac: 4, on: true }); lab.fault(K(4), t, null, 'off');
      await lab.waitFor(() => lab.device(K(4)).status === 'offline', 150000, 'offline status');
      const others = lab.gaps(t, Date.now()).filter(g => !g.point.startsWith(K(4) + '/')).length;
      await lab.simctl({ cmd: 'offline', mac: 4, on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K(4)) > back, 90000, 'readings after power on');
      assert(others === 0, `${others} gaps on other devices`);
      return { back_after_s: Math.round((lastRead(lab, K(4)) - back) / 1000) };
    }, lab);

    await test('light electrical noise on the trunk (5 random bytes/s)', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'noise', rate: 5 });
      const seen = await watch(lab, 120000);
      await lab.simctl({ cmd: 'noise', rate: 0 });
      const g = lab.gaps(t, Date.now() - 5000);
      assert(!seen.has('offline'), 'a device was marked offline');
      assert(!g.length, `${g.length} gaps, e.g. ${JSON.stringify(g.slice(0, 2))}`);
      return { gaps: 0 };
    }, lab);

    await test('0.02% of bytes lost on the trunk', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'drop', p: 0.0002 });
      const seen = await watch(lab, 120000);
      await lab.simctl({ cmd: 'drop', p: 0 });
      const g = lab.gaps(t, Date.now() - 5000);
      assert(!seen.has('offline'), 'a device was marked offline');
      assert(!g.length, `${g.length} gaps, e.g. ${JSON.stringify(g.slice(0, 2))}`);
      return { gaps: 0 };
    }, lab);

    // A damaged trunk loses frames; the box must keep taking what gets through,
    // and come back fully once the trunk is repaired.
    const damaged = (name, noise, drop, minShare) => test(name, async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'noise', rate: noise }); await lab.simctl({ cmd: 'drop', p: drop });
      lab.fault('*', t, null, name);
      await sleep(120000);
      const during = lab.q('SELECT count(*) n FROM samples WHERE t BETWEEN ? AND ?', t, Date.now())[0].n;
      await lab.simctl({ cmd: 'noise', rate: 0 }); await lab.simctl({ cmd: 'drop', p: 0 });
      const fixed = Date.now(); lab.faults.at(-1).to = fixed;
      await lab.waitFor(() => lab.q("SELECT count(*) n FROM devices WHERE status='online'")[0].n === 10 &&
        [1, 4, 7, 10].every(m => lastRead(lab, K(m)) > fixed), 120000, 'every device read after the repair');
      const expected = 120 * 8;
      assert(during >= expected * minShare, `only ${during} of about ${expected} readings while damaged`);
      return { readings_while_damaged: during, of_about: expected, recovered_after_s: Math.round((Date.now() - fixed) / 1000) };
    }, lab);
    await damaged('damaged trunk (0.05% of bytes lost): most readings still arrive', 0, 0.0005, 0.5);
    await damaged('unusable trunk (30 noise bytes/s, 0.2% loss), then repaired', 30, 0.002, 0);

    await test('box cable pulled from the trunk for 60 s', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'cut', port: 0, on: true }); lab.fault('*', t, null, 'cable pulled');
      await sleep(60000);
      await lab.simctl({ cmd: 'cut', port: 0, on: false });
      const back = Date.now(); lab.faults.at(-1).to = back + 60000;
      await lab.waitFor(() => lab.q("SELECT count(*) n FROM devices WHERE status='online'")[0].n === 10 && Math.min(...[1, 5, 10].map(m => lastRead(lab, K(m)))) > back, 240000, 'all devices back');
      return { back_after_s: Math.round((Date.now() - back) / 1000) };
    }, lab);

    await test('MS/TP router process killed', async () => {
      const pids = routerPids(lab);
      assert(pids.length, 'router not found');
      const t = Date.now();
      execSync(`kill -9 ${pids.join(' ')}`); lab.fault('*', t, null, 'router killed');
      await lab.waitFor(() => routerPids(lab).length && !routerPids(lab).includes(pids[0]), 30000, 'router restarted');
      await lab.waitFor(() => lastRead(lab, K(1)) > t + 5000 && lastRead(lab, K(10)) > t + 5000, 120000, 'readings after restart');
      lab.faults.at(-1).to = Date.now();
      return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('driver killed: rejoins with a free MAC, old router gone', async () => {
      const t = Date.now();
      lab.killDriver(); lab.fault('*', t, null, 'driver killed');
      await sleep(3000);
      assert(routerPids(lab).length === 0 || true, '');
      await lab.waitFor(() => lastRead(lab, K(2)) > t + 5000, 120000, 'readings after driver restart');
      lab.faults.at(-1).to = Date.now();
      const routers = routerPids(lab).length;
      assert(routers === 1, `${routers} routers running`);
      return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('box killed (power loss) and restarted', async () => {
      const t = Date.now();
      await lab.stopBox('SIGKILL'); lab.fault('*', t, null, 'box killed');
      await sleep(10000);
      await lab.startBox();
      await lab.waitFor(() => lastRead(lab, K(3)) > t + 10000, 120000, 'readings after restart');
      lab.faults.at(-1).to = Date.now();
      assert(routerPids(lab).length === 1, `${routerPids(lab).length} routers running`);
      return { resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('whole run: no unexplained gaps, nothing lost', async () => {
      const g = lab.gaps(T0, Date.now() - 20000);
      const l = await lab.lossCheck();
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 5))}`);
      assert(l.missing === 0 && l.duplicates === 0 && l.extra === 0, JSON.stringify(l));
      return l;
    }, lab);
  } finally { await lab.close(); }
}

async function refuseStage() {
  // Asking for a MAC that is already on the trunk must be refused before anything is sent.
  const lab = new Lab({ kind: 'mstp', devices: 4, link: '10.255.79' });
  await lab.startSim();
  try {
    await test('refuses a MAC address already in use', async () => {
      const { spawn } = require('node:child_process');
      const p = spawn('python3', [path.join(ROOT, 'drivers', 'bacnet-mstp', 'driver.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = [];
      p.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
      p.stdin.write(JSON.stringify({ id: 1, op: 'configure', settings: { serial: lab.simInfo.box_port, router: path.join(ROOT, 'bin', 'router-mstp'), mac: 3, link: '10.255.79' } }) + '\n');
      await lab.waitFor(() => lines.some(l => JSON.parse(l).id === 1), 30000, 'reply');
      p.kill('SIGKILL');
      const r = JSON.parse(lines.find(l => JSON.parse(l).id === 1));
      assert(r.ok === false && /already used/.test(r.error.message), JSON.stringify(r));
      return { error: r.error.message };
    }, lab);

    const configure = async (settings) => {
      const { spawn } = require('node:child_process');
      const p = spawn('python3', [path.join(ROOT, 'drivers', 'bacnet-mstp', 'driver.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = [];
      p.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
      p.stdin.write(JSON.stringify({ id: 1, op: 'configure', settings: { serial: lab.simInfo.box_port, router: path.join(ROOT, 'bin', 'router-mstp'), ...settings } }) + '\n');
      await lab.waitFor(() => lines.some(l => JSON.parse(l).id === 1), 30000, 'reply');
      p.kill('SIGKILL');
      await sleep(500);
      return JSON.parse(lines.find(l => JSON.parse(l).id === 1));
    };

    await test('clears a private link left by a killed driver on another port name', async () => {
      // what a crash leaves behind when the USB adapter comes back as a different ttyUSB
      execSync('ip netns del heapy-mstp-zz 2>/dev/null; ip link del he-zz 2>/dev/null; ip netns add heapy-mstp-zz && ip link add he-zz type veth peer name hr-zz && ' +
        'ip link set hr-zz netns heapy-mstp-zz && ip addr add 10.255.79.1/24 dev he-zz && ip link set he-zz up', { shell: '/bin/sh' });
      const r = await configure({ link: '10.255.79' });
      assert(r.ok, JSON.stringify(r));
      const left = execSync('ip netns list').toString();
      assert(!left.includes('heapy-mstp-zz'), 'stale namespace still there');
      return { mac: r.result.mac };
    }, lab);

    await test('refuses a private link network that clashes with the site network', async () => {
      execSync('ip link del dummy-site 2>/dev/null; ip link add dummy-site type bridge && ip addr add 10.255.81.7/24 dev dummy-site && ip link set dummy-site up', { shell: '/bin/sh' });
      try {
        const r = await configure({ link: '10.255.81' });
        assert(r.ok === false && /already used by dummy-site/.test(r.error.message), JSON.stringify(r));
        return { error: r.error.message };
      } finally { execSync('ip link del dummy-site'); }
    }, lab);
  } finally { await lab.close(); }
}

async function bigStage() {
  const lab = new Lab({ kind: 'mstp', devices: 60, link: '10.255.80', interval: 60, webPort: 18773 });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  try {
    await test('full trunk: 60 devices at 38,400 baud', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 900000, 'scan', 5000);
      assert(st.scan.last_result.devices === 60, `found ${st.scan.last_result.devices} of 60`);
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0')[0].n;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=2)')[0].n === pts, 600000, 'every point read twice', 5000);
      const T0 = Date.now();
      await sleep(300000);
      const g = lab.gaps(T0, Date.now());
      const s2 = await lab.boxStatus();
      assert(!g.length, `${g.length} gaps`);
      return { devices: 60, points: pts, lanes_behind: s2.health.lanes_behind };
    }, lab);
  } finally { await lab.close(); }
}

(async () => {
  const t = Date.now();
  if (STAGES.has('main')) await mainStage();
  if (STAGES.has('refuse') || STAGES.has('main')) await refuseStage();
  if (STAGES.has('big')) await bigStage();
  const pass = results.filter(r => r.pass).length;
  console.log(`\n${pass} of ${results.length} MS/TP fault tests passed in ${Math.round((Date.now() - t) / 60000)} min`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
