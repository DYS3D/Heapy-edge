'use strict';
// HEAPY Edge self-test. Unit checks always run. The site test runs against the
// simulated BACnet site (needs Linux root for the test network).
//   node tests/selftest.js            unit + site test
//   node tests/selftest.js --unit     unit checks only
process.env.HEAPY_EDGE_QUIET = '1';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}: ${e.message}`); }
  console.log(results[results.length - 1]);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  throw new Error('timed out waiting');
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edge-test-'));

async function unit() {
  console.log('Unit checks');
  const { inWindow } = require('../core/scanner');
  const { laneOf } = require('../core/scheduler');
  const { merge } = require('../core/config');
  const { hashPw, checkPw } = require('../core/web');
  const { Store } = require('../core/store');

  await check('scan windows, including across midnight', () => {
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
    assert(inWindow(['any'], at(12, 0)));
    assert(inWindow(['22:00-06:00'], at(23, 30)) && inWindow(['22:00-06:00'], at(5, 59)));
    assert(!inWindow(['22:00-06:00'], at(12, 0)));
    assert(inWindow(['09:00-10:00', '13:00-14:00'], at(13, 15)));
  });
  await check('routed devices share one lane per trunk', () => {
    assert.strictEqual(laneOf({ driver: 'b', key: 'bacnet://1', route: '2001:5' }), 'b:net2001');
    assert.strictEqual(laneOf({ driver: 'b', key: 'bacnet://2', route: '2001:9' }), 'b:net2001');
    assert.strictEqual(laneOf({ driver: 'b', key: 'bacnet://3', route: '10.1.2.3' }), 'b:bacnet://3');
  });
  await check('settings merge keeps defaults', () => {
    const m = merge({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2, 3] });
    assert.deepStrictEqual(m, { a: { b: 1, c: 3 }, l: [2, 3] });
  });
  await check('password hash', () => {
    const h = hashPw('correct horse');
    assert(checkPw('correct horse', h) && !checkPw('wrong', h));
  });
  await check('buffer: devices, points, samples, prune', () => {
    const dir = tmp();
    const s = new Store(path.join(dir, 't.db'));
    const { device } = s.upsertDevice('bacnet-ip', { key: 'bacnet://5', route: '10.0.0.5', name: 'D5', meta: { max_apdu: 480 } });
    assert.strictEqual(s.upsertPoint(device.id, { key: 'bacnet://5/analog-input:1', name: 'T', kind: 'number' }, { selected: true, interval_s: 900 }), 'created');
    assert.strictEqual(s.upsertPoint(device.id, { key: 'bacnet://5/analog-input:1', name: 'T', kind: 'number' }, { selected: true, interval_s: 900 }), 'same');
    const p = s.activePoints()[0];
    s.addSamples([{ p: p.id, t: Date.now() - 40 * 86400000, v: 1 }, { p: p.id, t: Date.now(), v: 2 }]);
    assert.strictEqual(s.counts().samples, 2);
    assert.strictEqual(s.prune(99, 30), 1);
    assert.strictEqual(s.markMissing(device.id, []), 1);
    assert.strictEqual(s.activePoints().length, 0);
    s.close();
  });
}

function haveSiteNet() {
  if (process.getuid && process.getuid() !== 0) return false;
  try { execFileSync('ip', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function site() {
  console.log('Site test (simulated BACnet site)');
  const { startMockIntake } = require('./mock-intake');
  const { EdgeApp } = require('../core/main');
  const AHUS = 6, VAVS = 40;
  const EXPECT_DEV = 1 + AHUS + 1 + VAVS;
  const EXPECT_PTS = 11 + AHUS * 15 + VAVS * 8;
  const RATE = 5;

  execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), ['20', 'bas-st', '10.79.0'], { stdio: 'ignore' });
  const statsFile = path.join(tmp(), 'sim-stats.json');
  const sim = spawn('ip', ['netns', 'exec', 'bas-st', process.env.HEAPY_EDGE_PYTHON || 'python3', path.join(ROOT, 'sim', 'bacnet_sim.py'),
    '--ahus', String(AHUS), '--vavs', String(VAVS), '--stats', statsFile, '--tick', '2', '--base', '10.79.0.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { sim.stdout.once('data', res); sim.once('exit', () => rej(new Error('simulator stopped'))); });

  const intake = await startMockIntake();
  const dataDir = tmp();
  const overrides = {
    web: { port: 0, bind: '127.0.0.1' },
    drivers: { 'bacnet-ip': { settings: { address: '10.79.0.2/24', instance: 4194001 }, rate_per_device: RATE, discover_timeout_s: 3 } },
    poll: { default_interval_s: 10 },
    upload: { every_s: 2, checkin_every_s: 2 },
  };
  let app = new EdgeApp({ dataDir, overrides });
  await app.start();
  const web = () => `http://127.0.0.1:${app.web.port()}`;
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(web() + '/api/' + p, body === undefined ? { headers: { cookie } } :
      { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-edge': '1' }, body: JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json() };
  };

  try {
    await check('driver starts', async () => { await waitFor(() => app.drivers['bacnet-ip']?.ready, 20000); });
    await check(`scan finds all ${EXPECT_DEV} devices (IP and behind the router)`, async () => {
      await waitFor(() => app.scanner.state.last_result && !app.scanner.state.running, 120000);
      const r = app.scanner.state.last_result;
      assert.strictEqual(r.devices, EXPECT_DEV, `found ${r.devices}`);
      const routed = app.store.devices().filter(d => /^2001:/.test(d.route));
      assert.strictEqual(routed.length, VAVS);
    });
    await check(`browse lists all ${EXPECT_PTS} points with names and units`, () => {
      const pts = app.store.points();
      assert.strictEqual(pts.length, EXPECT_PTS, `listed ${pts.length}`);
      const sat = pts.find(p => p.name === 'AHU-1.SA-T');
      assert(sat && sat.units === 'degrees-fahrenheit' && sat.description === 'Supply air temperature');
      const occ = pts.find(p => p.name === 'AHU-1.OCC-MODE');
      assert.deepStrictEqual(occ.states, ['Unoccupied', 'Occupied', 'Standby']);
    });
    await check('setup page: set password, wrong password refused, sign in', async () => {
      assert.strictEqual((await call('status')).status, 401);
      assert.strictEqual((await call('setup-password', { password: 'short' })).status, 400);
      assert.strictEqual((await call('setup-password', { password: 'edge-test-password' })).status, 200);
      cookie = '';
      assert.strictEqual((await call('login', { password: 'nope-nope-nope' })).status, 401);
      assert.strictEqual((await call('login', { password: 'edge-test-password' })).status, 200);
      assert.strictEqual((await call('status')).status, 200);
      const r = await fetch(web() + '/api/scan', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.strictEqual(r.status, 403, 'POST without the page header must be refused');
    });
    await check('pairing: bad code refused, good code connects', async () => {
      const bad = await call('pair', { url: intake.url, code: 'NOPE' });
      assert.strictEqual(bad.status, 400);
      const ok = await call('pair', { url: intake.url, code: 'TEST-0001' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.box_id, 'box-1');
      const saved = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
      assert(!saved.includes(app.config.secret().key), 'box key must not be in settings.json');
      assert.strictEqual((fs.statSync(path.join(dataDir, 'secret.json')).mode & 0o777).toString(8), '600');
    });
    await check('every point read at least 3 times on its interval', async () => {
      try {
        await waitFor(() => {
          const n = app.store.db.prepare('SELECT count(*) n FROM (SELECT p, count(*) c FROM samples GROUP BY p HAVING c>=3)').get().n;
          return n === EXPECT_PTS;
        }, 90000, 1000);
      } catch (e) {
        const short = app.store.db.prepare(`SELECT pt.name, d.name dev, d.last_error, (SELECT count(*) FROM samples s WHERE s.p=pt.id) c
          FROM points pt JOIN devices d ON d.id=pt.device_id WHERE c<3 LIMIT 8`).all();
        throw new Error('short: ' + JSON.stringify(short));
      }
    });
    await check('slow device, device without ReadPropertyMultiple and routed devices all have values', () => {
      for (const name of ['AHU-2.SA-T', 'AHU-3.SA-T']) {
        const p = app.store.points().find(x => x.name === name);
        assert(p.last_v > 40 && p.last_v < 70, `${name} = ${p.last_v}`);
      }
      const vav = app.store.devices().find(d => d.name === 'VAV-10');
      const vp = app.store.points(vav.id).find(p => p.name === 'ZN-T');
      assert(vp.last_v > 60 && vp.last_v < 80);
    });
    await check('uploads reach the server with devices, points and no duplicates', async () => {
      await waitFor(() => intake.st.samples.length >= EXPECT_PTS * 3, 30000);
      assert.strictEqual(intake.st.devices.size, EXPECT_DEV);
      assert.strictEqual(intake.st.points.size, EXPECT_PTS);
      assert.strictEqual(intake.st.dupSamples, 0);
    });
    await check('server down for 12 s: readings wait, then all arrive once', async () => {
      intake.st.mode = '500'; intake.st.modeUntil = Date.now() + 12000;
      await sleep(12500);
      const backlog = app.uploader.health().server.backlog;
      assert(backlog > 0, 'backlog should grow while the server is down');
      await waitFor(async () => { await app.uploader.tick(true); return app.uploader.health().server.backlog === 0; }, 60000, 1000);
      const sent = app.store.db.prepare('SELECT count(*) n FROM samples').get().n;
      assert.strictEqual(intake.st.seen.size, sent, `server has ${intake.st.seen.size}, box sent ${sent}`);
      assert.strictEqual(intake.st.dupSamples, 0);
    });
    await check(`no device asked more than ${RATE} requests per second`, () => {
      const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      const worst = Object.entries(stats).sort((a, b) => b[1].max_rate - a[1].max_rate)[0];
      assert(worst[1].max_rate <= RATE + 1, `${worst[0]} saw ${worst[1].max_rate}/s`);
    });
    await check('no gaps: consecutive readings of each point are one interval apart', () => {
      const rows = app.store.db.prepare(`SELECT p, t FROM samples WHERE t > ? ORDER BY p, t`).all(Date.now() - 60000);
      let worst = 0, prev = null;
      for (const r of rows) { if (prev && prev.p === r.p) worst = Math.max(worst, r.t - prev.t); prev = r; }
      assert(worst < 2 * 10000, `largest gap ${worst} ms on a 10 s interval`);
    });
    await check('device that stops answering is marked offline, others keep going', async () => {
      const { device } = app.store.upsertDevice('bacnet-ip', { key: 'bacnet://9999', route: '10.79.0.250', name: 'GONE', meta: { max_apdu: 480 } });
      app.store.upsertPoint(device.id, { key: 'bacnet://9999/analog-input:1', name: 'X', kind: 'number' }, { selected: true, interval_s: 10 });
      app.scheduler.invalidate();
      await waitFor(() => app.store.device('bacnet://9999').status === 'offline', 150000, 1000);
      const before = app.scheduler.stats.samples;
      await sleep(11000);
      assert(app.scheduler.stats.samples > before + EXPECT_PTS / 2, 'other devices must keep being read');
    });
    await check('change of value: AHU-1 subscribes, AHU-4 (no COV) stays on polling', async () => {
      await app.applySettings({ poll: { use_cov: true } });
      await app.scheduler.covTick();
      const ahu1 = app.store.device('bacnet://1201');
      const cov1 = app.store.points(ahu1.id).filter(p => p.cov_active).length;
      assert(cov1 >= 10, `AHU-1 COV points: ${cov1}`);
      const ahu4 = app.store.device('bacnet://1204');
      assert.strictEqual(app.store.points(ahu4.id).filter(p => p.cov_active).length, 0);
      await waitFor(() => app.scheduler.stats.cov_samples > 0, 30000);
    });
    await check('settings pushed by the server at check-in are applied', async () => {
      const key = 'bacnet://1201/analog-input:4';
      intake.st.config = { points: [{ key, selected: false }] }; intake.st.configVersion = 1;
      await app.link.tick(true);
      assert.strictEqual(app.store.points().find(p => p.key === key).selected, 0);
      assert(intake.st.lastHealth && intake.st.lastHealth.devices === EXPECT_DEV + 1);
    });
    await check('restart keeps the buffer and does not resend', async () => {
      await app.stop();
      const sentBefore = intake.st.seen.size;
      app = new EdgeApp({ dataDir, overrides });
      await app.start();
      await waitFor(() => app.drivers['bacnet-ip']?.ready, 20000);
      await sleep(15000);
      await app.uploader.tick(true);
      assert(intake.st.seen.size > sentBefore, 'new readings after restart');
      assert.strictEqual(intake.st.dupSamples, 0);
      assert.strictEqual(app.scanner.state.last_result, null, 'no full rescan right after a restart');
    });
  } finally {
    await app.stop().catch(() => {});
    await intake.close();
    sim.kill('SIGTERM');
  }
}

(async () => {
  await unit();
  if (!process.argv.includes('--unit')) {
    if (haveSiteNet()) await site();
    else console.log('Site test skipped (needs Linux root and the ip command)');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
