'use strict';
// HEAPY Edge fault test suite for the BACnet/IP driver (needs Linux root).
//   node tests/faults.js [--only name,name] [--stages main,clock,disk,big] [--out report.json]
// Every test injects a fault, checks the box's reaction, and the run ends with
// two global checks: no reading gap that a recorded fault does not explain, and
// every reading in the buffer reached the server exactly once.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { Lab, sleep } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? new Set(arg('only').split('|')) : null;
const STAGES = new Set((arg('stages', 'main,clock,disk,big')).split(','));
// --web-port / --net / --prefix: run beside another lab or a soak on the same machine
const LABOPTS = { webPort: Number(arg('web-port', 18770)), net: arg('net', 'bas-sim'), prefix: arg('prefix', '10.77.0') };
const OUT = arg('out', path.join(__dirname, '..', 'fault-report.json'));
const results = [];

async function test(name, fn, lab) {
  if (ONLY && !ONLY.has(name)) return;
  const t = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const detail = await fn(lab) || {};
    results.push({ name, pass: true, secs: Math.round((Date.now() - t) / 1000), detail });
    console.log(`  ✔ ${name} (${Math.round((Date.now() - t) / 1000)} s) ${JSON.stringify(detail).slice(0, 300)}`);
  } catch (e) {
    results.push({ name, pass: false, secs: Math.round((Date.now() - t) / 1000), error: e.message });
    console.log(`  ✘ ${name}: ${e.message}`);
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const K = { plant: 'bacnet://1100', ahu: n => `bacnet://${1200 + n}`, vav: n => `bacnet://${20000 + n}` };

// share of expected readings present for a device between t0 and t1
function fill(lab, dkey, t0, t1) {
  const pts = lab.q(`SELECT count(*) n FROM points p JOIN devices d ON d.id=p.device_id WHERE d.key=? AND p.selected=1 AND p.missing=0`, dkey)[0].n;
  const got = lab.q(`SELECT count(*) n FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=? AND s.t BETWEEN ? AND ?`, dkey, t0, t1)[0].n;
  const slots = Math.floor((t1 - t0) / (lab.o.interval * 1000));
  return slots && pts ? got / (pts * slots) : 0;
}
async function watchStatus(lab, dkey, ms) {
  const seen = new Set(); const end = Date.now() + ms;
  while (Date.now() < end) { const d = lab.device(dkey); if (d) seen.add(d.status); await sleep(2000); }
  return seen;
}
const lastRead = (lab, dkey) => lab.q(`SELECT max(s.t) t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id WHERE d.key=?`, dkey)[0].t || 0;

async function mainStage() {
  const lab = new Lab({ ...LABOPTS, tiny: true });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const spare = lab.simInfo.spare_ips;
  let T0;
  try {
    await test('baseline: scan and first readings', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 180000, 'scan');
      const r = st.scan.last_result;
      assert(r.devices === lab.simInfo.devices, `found ${r.devices} of ${lab.simInfo.devices} devices`);
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0')[0].n;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === pts, 120000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { devices: r.devices, points: pts };
    }, lab);

    await test('device stops answering, then returns', async () => {
      const k = K.ahu(1), t = Date.now();
      await lab.simctl({ cmd: 'offline', device: 1201, on: true }); lab.fault(k, t, null, 'offline');
      await lab.waitFor(() => lab.device(k).status === 'offline', 150000, 'offline status');
      const others = lab.gaps(t, Date.now()).filter(g => !g.point.startsWith(k + '/')).length;
      await sleep(Math.max(0, t + 60000 - Date.now()));
      await lab.simctl({ cmd: 'offline', device: 1201, on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, k) > back, 30000, 'readings after return');
      assert(others === 0, `${others} gaps on other devices`);
      return { back_after_s: Math.round((lastRead(lab, k) - back) / 1000) };
    }, lab);

    await test('device behind router reboots', async () => {
      const k = K.vav(5), t = Date.now();
      await lab.simctl({ cmd: 'reboot', device: 20005, secs: 45 }); lab.fault(k, t, t + 45000, 'reboot');
      await sleep(46000);
      await lab.waitFor(() => lastRead(lab, k) > t + 45000, 30000, 'readings after reboot');
      return { back_after_s: Math.round((lastRead(lab, k) - t - 45000) / 1000) };
    }, lab);

    await test('30% of requests lost to one device', async () => {
      const k = K.ahu(5), t = Date.now();
      await lab.simctl({ cmd: 'drop', device: 1205, p: 0.3 });
      const seen = await watchStatus(lab, k, 120000);
      await lab.simctl({ cmd: 'drop', device: 1205, p: 0 });
      const g = lab.devGaps(k, t, Date.now() - 5000);
      assert(!seen.has('offline'), 'device was marked offline');
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { gaps: 0 };
    }, lab);

    await test('10% packet loss on the whole BAS network', async () => {
      const t = Date.now();
      lab.lossOn(0.10);
      try { await sleep(120000); } finally { lab.lossOff(); }
      const offline = lab.q("SELECT key FROM devices WHERE status='offline'");
      const g = lab.gaps(t, Date.now() - 5000);
      assert(!offline.length, `offline: ${offline.map(r => r.key)}`);
      assert(!g.length, `${g.length} gaps, e.g. ${JSON.stringify(g.slice(0, 3))}`);
      return { gaps: 0 };
    }, lab);

    await test('slow device (2-3 s replies)', async () => {
      const k = K.ahu(6), t = Date.now();
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 2, jitter: 1 });
      const seen = await watchStatus(lab, k, 120000);
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 0, jitter: 0 });
      const g = lab.devGaps(k, t + 10000, Date.now() - 5000);
      assert(!seen.has('offline'), 'slow device marked offline');
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { gaps: 0 };
    }, lab);

    await test('very slow device (4-6 s, past the BACnet retry time) keeps being read', async () => {
      const k = K.ahu(6), t = Date.now();
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 4, jitter: 2 });
      const seen = await watchStatus(lab, k, 120000);
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 0, jitter: 0 });
      lab.fault(k, t, Date.now(), 'very slow');
      const rows = lab.q(`SELECT s.t FROM samples s JOIN points p ON p.id=s.p WHERE p.key=? AND s.t BETWEEN ? AND ? ORDER BY s.t`, `${k}/analog-input:1`, t + 15000, Date.now());
      let worst = 0; for (let i = 1; i < rows.length; i++) worst = Math.max(worst, rows[i].t - rows[i - 1].t);
      assert(!seen.has('offline'), 'marked offline');
      assert(worst <= 2.5 * lab.o.interval * 1000, `longest gap ${Math.round(worst / 1000)} s`);
      return { readings: rows.length, longest_gap_s: Math.round(worst / 1000) };
    }, lab);

    await test('device too slow to answer (25 s), then normal', async () => {
      const k = K.ahu(6), t = Date.now();
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 25 }); lab.fault(k, t, null, 'too slow');
      await lab.waitFor(() => lab.device(k).status === 'offline', 120000, 'offline status');
      await lab.simctl({ cmd: 'slow', device: 1206, secs: 0 });
      const back = Date.now(); lab.faults.at(-1).to = back + 25000; // replies already queued still arrive late
      await lab.waitFor(() => lab.device(k).status === 'online' && lastRead(lab, k) > back, 90000, 'back online');
      return { back_after_s: Math.round((lastRead(lab, k) - back) / 1000) };
    }, lab);

    await test('device answers every read with an error', async () => {
      const k = K.plant, t = Date.now();
      await lab.simctl({ cmd: 'error', device: 1100, kind: 'error' }); lab.fault(k, t, null, 'errors');
      await lab.waitFor(() => lab.device(k).status === 'error', 150000, "'error' status");
      await lab.simctl({ cmd: 'error', device: 1100, kind: null });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lab.device(k).status === 'online' && lastRead(lab, k) > back, 60000, 'back online');
      return { back_after_s: Math.round((lastRead(lab, k) - back) / 1000) };
    }, lab);

    await test('invalid values (NaN, infinity) are not stored', async () => {
      const k = K.ahu(1), t = Date.now();
      const bad = [1, 2, 3].map(i => `${k}/analog-input:${i}`);
      await lab.simctl({ cmd: 'odd', device: 1201, on: true }); bad.forEach(b => lab.fault(b, t, null, 'odd values'));
      await sleep(45000);
      const errs = lab.q(`SELECT key, last_error FROM points WHERE key IN (?,?,?)`, ...bad);
      assert(errs.every(r => /invalid value/.test(r.last_error || '')), `point errors: ${JSON.stringify(errs)}`);
      const stored = lab.q(`SELECT count(*) n FROM samples s JOIN points p ON p.id=s.p WHERE p.key IN (?,?,?) AND s.t > ?`, ...bad, t + 12000)[0].n;
      assert(stored === 0, `${stored} invalid values stored`);
      const others = lab.devGaps(k, t + 12000, Date.now()).length;
      assert(others === 0, `${others} gaps on the device's other points`);
      await lab.simctl({ cmd: 'odd', device: 1201, on: false });
      const back = Date.now(); lab.faults.slice(-3).forEach(f => { f.to = back; });
      await lab.waitFor(() => lab.q(`SELECT count(*) n FROM points WHERE key IN (?,?,?) AND last_error IS NULL`, ...bad)[0].n === 3, 40000, 'errors to clear');
      return { other_point_gaps: others };
    }, lab);

    await test('points removed from a device are found and dropped', async () => {
      const k = K.ahu(5);
      const r = await lab.simctl({ cmd: 'remove', device: 1205, n: 2 });
      const gone = r.removed.map(o => `${k}/${o}`);
      const t = Date.now(); gone.forEach(g => lab.fault(g, t, null, 'removed'));
      await lab.waitFor(() => lab.q(`SELECT count(*) n FROM points WHERE key IN (?,?) AND missing=1`, ...gone)[0].n === 2, 120000, 'points marked gone');
      const added = await lab.simctl({ cmd: 'add', device: 1205, n: 3 });
      await lab.api('scan', { browse_all: true });
      await lab.waitFor(async () => { const s = await lab.boxStatus(); return !s.scan.running && s.scan.last_end > t; }, 240000, 'rescan');
      const newPts = lab.q(`SELECT id FROM points WHERE key LIKE ? AND name LIKE '%NEW-%'`, `${k}/%`);
      assert(newPts.length === 3, `found ${newPts.length} new points`);
      await lab.waitFor(() => lab.q(`SELECT count(*) n FROM samples WHERE p IN (${newPts.map(p => p.id)})`)[0].n >= 6, 60000, 'new points read');
      return { removed: r.removed, added: added.added };
    }, lab);

    await test('device moves to a new IP address', async () => {
      const k = K.ahu(4), t = Date.now();
      await lab.simctl({ cmd: 'move', device: 1204, ip: spare[0] }); lab.fault(k, t, null, 'moved');
      await lab.waitFor(() => lab.device(k).route === spare[0], 120000, 'new address picked up');
      const moved = Date.now(); lab.faults.at(-1).to = moved;
      await lab.waitFor(() => lastRead(lab, k) > moved, 40000, 'readings at the new address');
      return { found_after_s: Math.round((moved - t) / 1000) };
    }, lab);

    await test('second device with the same device number', async () => {
      const k = K.ahu(2), t = Date.now();
      const home = lab.device(k).route;
      await lab.simctl({ cmd: 'duplicate', device: 1202, ip: spare[1] });
      await lab.waitFor(() => /duplicate_id/.test(lab.device(k).meta || ''), 120000, 'duplicate flagged');
      await lab.api('scan', {});
      await lab.waitFor(async () => { const s = await lab.boxStatus(); return !s.scan.running && s.scan.last_end > t; }, 240000, 'rescan');
      const dup = lab.q(`SELECT * FROM devices WHERE key LIKE ?`, `${k}~%`);
      assert(dup.length === 1 && dup[0].route === spare[1], `duplicate device rows: ${JSON.stringify(dup.map(d => [d.key, d.route]))}`);
      assert(lab.device(k).route === home, `original moved to ${lab.device(k).route}`);
      await lab.waitFor(() => lastRead(lab, dup[0].key) > t, 90000, 'duplicate read');
      return { original: home, duplicate: dup[0].key };
    }, lab);

    await test('I-Am storm from every IP device', async () => {
      const t = Date.now();
      await lab.simctl({ cmd: 'storm', secs: 30, rate: 10 });
      await sleep(45000);
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    }, lab);

    await test('driver process killed', async () => {
      const t = Date.now();
      lab.killDriver();
      lab.fault('*', t, null, 'driver killed');
      // both an IP device and one behind the router must be read again quickly: a fresh
      // driver has to learn the routers by itself, not wait for the next scan
      await lab.waitFor(() => lab.q('SELECT max(id) m FROM samples')[0].m && lastRead(lab, K.ahu(1)) > t + 1000 && lastRead(lab, K.vav(3)) > t + 1000, 60000, 'IP and routed readings after restart');
      lab.faults.at(-1).to = Date.now();
      const st = await lab.boxStatus();
      assert(st.health.driver_restarts >= 1, 'no restart counted');
      const bad = lab.q("SELECT name, last_error FROM devices WHERE last_error LIKE '%unknown-route%'");
      assert(!bad.length, `routed devices unreachable after the restart: ${JSON.stringify(bad.slice(0, 3))}`);
      return { resumed_after_s: Math.round((lab.faults.at(-1).to - t) / 1000) };
    }, lab);

    await test('box killed (power loss) and restarted', async () => {
      const t = Date.now();
      await lab.stopBox('SIGKILL'); lab.fault('*', t, null, 'box killed');
      const ok = lab.q('PRAGMA integrity_check')[0].integrity_check;
      await sleep(15000);
      await lab.startBox();
      await lab.waitFor(() => lastRead(lab, K.ahu(1)) > t + 15000 && lastRead(lab, K.vav(3)) > t + 15000, 60000, 'IP and routed readings after restart');
      lab.faults.at(-1).to = Date.now();
      const st = await lab.boxStatus();
      assert(ok === 'ok', `database check: ${ok}`);
      const bad = lab.q("SELECT name, last_error FROM devices WHERE last_error LIKE '%unknown-route%'");
      assert(!bad.length, `routed devices unreachable after the restart: ${JSON.stringify(bad.slice(0, 3))}`);
      assert(!st.scan.running || st.scan.last_start < t, 'full rescan started after restart');
      return { integrity: ok, resumed_after_s: Math.round((Date.now() - t) / 1000) };
    }, lab);

    await test('server failures: errors, slow, garbage, revoked key, size limit', async () => {
      const seq = [['500', 40], ['429', 30], ['hang', 75], ['garbage', 30], ['wrong_id', 30], ['401', 40]];
      for (const [mode, secs] of seq) {
        await lab.srv('/mode', { mode, ms: secs * 1000 });
        await sleep(secs * 1000 + 2000);
        const s = await lab.boxStatus();
        assert(s.destinations.server.backlog > 0, `no backlog during ${mode}`);
      }
      await lab.srv('/mode', { mode: '413', max_samples: 300 });
      await lab.waitFor(async () => (await lab.boxStatus()).destinations.server.backlog < 400, 240000, 'backlog drained through size limit');
      await lab.srv('/mode', { mode: 'ok' });
      const l = await lab.lossCheck();
      assert(l.missing === 0 && l.duplicates === 0 && l.extra === 0, JSON.stringify(l));
      return l;
    }, lab);

    await test('whole run: no unexplained gaps, nothing lost, rate limits kept', async () => {
      const g = lab.gaps(T0, Date.now() - 20000);
      const l = await lab.lossCheck();
      const [dev, rate] = lab.maxRate();
      const st = await lab.boxStatus();
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 5))}`);
      assert(l.missing === 0 && l.duplicates === 0 && l.extra === 0 && l.box_dup_rows === 0, JSON.stringify(l));
      assert(rate <= 6, `${dev} saw ${rate} requests in one second`);
      return { ...l, max_rate: rate, poll: st.poll, faults: lab.faults.length };
    }, lab);
  } finally {
    await lab.close();
  }
}

async function clockStage() {
  const lab = new Lab({ ...LABOPTS, ahus: 3, vavs: 10 });
  await lab.startSim(); await lab.startServer(); await lab.startBox({ faketime: true });
  const rowsSince = id => lab.q('SELECT count(*) n FROM samples WHERE id>?', id)[0].n;
  const maxId = () => lab.q('SELECT coalesce(max(id),0) m FROM samples')[0].m;
  try {
    await test('clock jumps forward and back an hour', async () => {
      await lab.waitFor(async () => (await lab.boxStatus()).scan.last_result, 120000, 'scan');
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0 AND selected=1')[0].n;
      await sleep(30000);
      const per40 = pts * 4; // readings expected in 40 s at 10 s
      let id = maxId();
      fs.writeFileSync(lab.ftFile, '+3600');
      await sleep(40000);
      const fwd = rowsSince(id); id = maxId();
      fs.writeFileSync(lab.ftFile, '+0');
      await sleep(40000);
      const back = rowsSince(id);
      const st = await lab.boxStatus();
      assert(st.poll.clock_jumps >= 2, `clock jumps seen: ${st.poll.clock_jumps}`);
      assert(fwd >= per40 * 0.7 && back >= per40 * 0.7, `readings after jumps: +1h ${fwd}, -1h ${back}, expected about ${per40}`);
      const l = await lab.lossCheck();
      assert(l.missing === 0 && l.duplicates === 0, JSON.stringify(l));
      return { after_forward: fwd, after_back: back, expected: per40, clock_jumps: st.poll.clock_jumps };
    }, lab);
  } finally { await lab.close(); }
}

async function diskStage() {
  const mnt = '/tmp/edge-disk';
  fs.mkdirSync(mnt, { recursive: true });
  try { execSync(`umount ${mnt}`, { stdio: 'ignore' }); } catch { /* not mounted */ }
  execSync(`mount -t tmpfs -o size=24m tmpfs ${mnt}`);
  const lab = new Lab({ ...LABOPTS, ahus: 3, vavs: 10, dataDir: path.join(mnt, 'data') });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const maxId = () => lab.q('SELECT coalesce(max(id),0) m FROM samples')[0].m;
  try {
    await test('disk full, then space freed', async () => {
      await lab.waitFor(async () => (await lab.boxStatus()).scan.last_result, 120000, 'scan');
      await sleep(20000);
      // stop uploads so nothing can be freed by the box, then fill the disk
      await lab.srv('/mode', { mode: '500' });
      try { execSync(`dd if=/dev/zero of=${mnt}/filler bs=1M count=100 2>/dev/null`); } catch { /* disk full is the point */ }
      const t = Date.now();
      const before = maxId();
      await lab.waitFor(async () => (await lab.boxStatus()).health.store_problem, 300000, 'buffer problem to be reported', 5000);
      const st = await lab.boxStatus();
      assert(st && !lab.boxExit, 'box stopped');
      const whileFull = maxId() - before;
      fs.unlinkSync(`${mnt}/filler`);
      await lab.srv('/mode', { mode: 'ok' });
      const id = maxId();
      await lab.waitFor(() => maxId() > id + 20, 60000, 'readings saved again');
      lab.fault('*', t - 5000, Date.now(), 'disk full');
      const l = await lab.lossCheck();
      assert(l.missing === 0 && l.duplicates === 0, JSON.stringify(l));
      return { problem: st.health.store_problem, saved_while_filling: whileFull, ...l };
    }, lab);
  } finally {
    await lab.close();
    try { execSync(`umount ${mnt}`); } catch { /* */ }
  }
}

async function bigStage() {
  const lab = new Lab({ ...LABOPTS, ahus: 6, vavs: 110, trunks: 8, vavsPerTrunk: 110, extraIp: 150, big: 3000, tiny: true, interval: 60, ips: 200 });
  await lab.startSim(); await lab.startServer();
  await lab.startBox({ overrides: { drivers: { 'bacnet-ip': { discover_timeout_s: 5 } } } });
  try {
    await test(`large site (${lab.simInfo.devices} devices)`, async () => {
      const t = Date.now();
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 1800000, 'scan', 5000);
      const scanS = Math.round((Date.now() - t) / 1000);
      const r = st.scan.last_result;
      assert(r.devices === lab.simInfo.devices, `found ${r.devices} of ${lab.simInfo.devices}`);
      const pts = lab.q('SELECT count(*) n FROM points WHERE missing=0 AND selected=1')[0].n;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=2)')[0].n === pts, 600000, 'every point read twice', 5000);
      const T0 = Date.now();
      await sleep(300000);
      const g = lab.gaps(T0, Date.now());
      const [dev, rate] = lab.maxRate();
      const mem = execSync(`ps -o rss= -p ${lab.box.pid}`).toString().trim();
      const s2 = await lab.boxStatus();
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      assert(rate <= 6, `${dev} saw ${rate}/s`);
      return { devices: r.devices, points: pts, scan_s: scanS, box_rss_mb: Math.round(mem / 1024), missed_slots: s2.poll.missed_slots };
    }, lab);
  } finally { await lab.close(); }
}

(async () => {
  const t = Date.now();
  if (STAGES.has('main')) await mainStage();
  if (STAGES.has('clock')) await clockStage();
  if (STAGES.has('disk')) await diskStage();
  if (STAGES.has('big')) await bigStage();
  const pass = results.filter(r => r.pass).length;
  console.log(`\n${pass} of ${results.length} fault tests passed in ${Math.round((Date.now() - t) / 60000)} min`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
