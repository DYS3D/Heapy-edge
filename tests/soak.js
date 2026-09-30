'use strict';
// Long run against the simulated site: reads every point every --interval
// seconds for --minutes and reports gaps, request rates, upload duplicates and
// memory. 120 minutes at 10 s = 720 reading slots per point, more than 7 days
// of 15-minute readings (672 slots).
//   node tests/soak.js --minutes 120 --interval 10 --ahus 6 --vavs 40 --out soak.json
process.env.HEAPY_EDGE_QUIET = '1';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EdgeApp } = require('../core/main');
const { startMockIntake } = require('./mock-intake');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const MIN = Number(arg('minutes', 120)), IV = Number(arg('interval', 10));
const AHUS = Number(arg('ahus', 6)), VAVS = Number(arg('vavs', 40)), RATE = Number(arg('rate', 5));
const OUT = arg('out', 'soak.json');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(Math.max(20, AHUS + 5))], { stdio: 'ignore' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-soak-'));
  const statsFile = path.join(dir, 'sim-stats.json');
  const sim = spawn('ip', ['netns', 'exec', 'bas-sim', 'python3', path.join(ROOT, 'sim', 'bacnet_sim.py'),
    '--ahus', String(AHUS), '--vavs', String(VAVS), '--stats', statsFile, '--tick', '2'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => sim.stdout.once('data', r));
  // test server in its own process, so the memory figures are the box's alone
  const port = 8790 + Math.floor(Math.random() * 100);
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-intake.js'), String(port), 'k'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => mock.stdout.once('data', r));
  const intake = { url: `http://127.0.0.1:${port}` };
  const stats = async () => (await fetch(intake.url + '/stats')).json();
  const app = new EdgeApp({ dataDir: path.join(dir, 'data'), overrides: {
    web: { port: 0, bind: '127.0.0.1' },
    drivers: { 'bacnet-ip': { settings: { address: '10.77.0.2/24' }, rate_per_device: RATE, discover_timeout_s: 3 } },
    poll: { default_interval_s: IV }, upload: { every_s: 30, checkin_every_s: 60 }, buffer: { keep_days: 30 },
  } });
  await app.start();
  app.config.setSecret({ box_id: 'box-soak', key: 'k' });
  app.config.update({ destinations: app.config.get().destinations.map(d => d.name === 'server' ? { ...d, url: intake.url, enabled: true } : d) });

  while (!app.scanner.state.last_result) await sleep(1000);
  const t0 = Date.now() + 2 * IV * 1000; // measure after the first readings settle
  const snaps = [];
  const end = Date.now() + MIN * 60000;
  // one server outage in the middle, to prove nothing is lost
  setTimeout(() => { fetch(intake.url + '/fail', { method: 'POST', body: '{"ms":120000}' }).catch(() => {}); }, MIN * 30000);
  while (Date.now() < end) {
    await sleep(60000);
    const mem = process.memoryUsage();
    snaps.push({ t: Date.now(), rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576), ...app.scheduler.stats, backlog: app.uploader.health().server.backlog });
    fs.writeFileSync(OUT, JSON.stringify({ running: true, snaps }, null, 1));
  }
  for (let i = 0; i < 20 && app.uploader.health().server.backlog > 0; i++) { await app.uploader.tick(true); await sleep(1000); }
  const t1 = Date.now() - 2 * IV * 1000;

  const rows = app.store.db.prepare('SELECT p, t FROM samples WHERE t BETWEEN ? AND ? ORDER BY p, t').all(t0, t1);
  const nPts = app.store.activePoints().length;
  let gaps = 0, worst = 0, prev = null;
  const per = new Map();
  for (const r of rows) {
    per.set(r.p, (per.get(r.p) || 0) + 1);
    if (prev && prev.p === r.p) { const g = r.t - prev.t; if (g > 1.5 * IV * 1000) gaps++; worst = Math.max(worst, g); }
    prev = r;
  }
  const slots = Math.floor((t1 - t0) / (IV * 1000));
  const minPer = Math.min(...per.values());
  const simStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  const maxRate = Math.max(...Object.values(simStats).map(s => s.max_rate));
  const srv = await stats();
  const sent = app.store.db.prepare('SELECT count(*) n FROM samples').get().n;
  const result = {
    running: false, minutes: MIN, interval_s: IV, devices: app.store.devices().length, points: nPts,
    slots_per_point: slots, readings: rows.length, expected: slots * nPts, min_readings_one_point: minPer,
    gaps_over_1_5_intervals: gaps, largest_gap_s: worst / 1000, max_requests_per_s_one_device: maxRate,
    read_errors: app.scheduler.stats.read_errors, missed_slots: app.scheduler.stats.missed_slots,
    server_has: srv.seen, box_has: sent, duplicates: srv.dup,
    rss_mb_start: snaps[0]?.rss_mb, rss_mb_end: snaps[snaps.length - 1]?.rss_mb, snaps,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, snaps: undefined }, null, 1));
  await app.stop(); mock.kill(); sim.kill('SIGTERM');
  process.exit(0);
})();
