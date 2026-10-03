'use strict';
// 24-hour soak with scheduled faults, for any driver (--kind bacnet-ip | mstp |
// modbus | snmp | haystack | obix). Resumable: if the machine
// running it restarts, run it again with the same --dir and it carries on; the
// time it was down is recorded and excluded from the gap check.
//   node tests/soak24.js --hours 24 --dir /home/claude/soak24
// Pass: no reading lost between box and server, no gap a fault doesn't explain,
// box memory steady, the box and driver only restart when the test kills them.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { Lab, sleep } = require('./lab');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const HOURS = Number(arg('hours', 24));
const DIR = path.resolve(arg('dir', '/home/claude/soak24'));
const IV = Number(arg('interval', 60));
// --segment-minutes N: stop after N minutes and leave the state for the next
// run to pick up (GitHub Actions jobs are limited to 6 hours)
const SEG_MIN = Number(arg('segment-minutes', 0));
const SEG_END = SEG_MIN ? Date.now() + SEG_MIN * 60000 : Infinity;
const KIND = arg('kind', 'bacnet-ip');
const STATE = path.join(DIR, 'state.json');
fs.mkdirSync(DIR, { recursive: true });

const now = () => Date.now();
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
const save = st => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(STATE + '.tmp', STATE); };
const MIN = 60000;

// One hour of faults, repeated. [minute, what, device/detail, minutes]
const CYCLE = [
  [2, 'offline', 1201, 5],
  [9, 'reboot', 20005, 1.5],
  [12, 'drop', 1205, 10, 0.2],
  [24, 'netloss', '*', 10, 0.05],
  [36, 'slow', 1206, 10, 2],
  [47, 'error', 1100, 5],
  [53, 'odd', 1202, 3],
  [57, 'storm', '*', 0.3],
];
// Less frequent: [every_h, minute, what, minutes]
const RARE = [
  [2, 20, 'server500', 10],
  [3, 40, 'serverhang', 3],
  [4, 30, 'killdriver', 0],
  [6, 45, 'killbox', 0.5],
  [8, 15, 'clock', 2],
];

// Hourly fault cycles for the other drivers: [minute, label, minutes, on(lab), off(lab), device keys that may lose readings]
const F = (dev, f, v = true) => [lab => lab.simctl({ cmd: 'fault', dev, f, v, on: true }), lab => lab.simctl({ cmd: 'fault', dev, f, on: false })];
const NET = p => [async lab => lab.lossOn(p), async lab => lab.lossOff()];
const PLANS = {
  mstp: {
    lab: { kind: 'mstp', devices: 20, link: '10.255.85' }, key: m => `bacnet://${30000 + m}`,
    cycle: [
      [2, 'MS/TP device 4 off', 5, lab => lab.simctl({ cmd: 'offline', mac: 4, on: true }), lab => lab.simctl({ cmd: 'offline', mac: 4, on: false }), [4]],
      [12, 'trunk noise 5 bytes/s', 10, lab => lab.simctl({ cmd: 'noise', rate: 5 }), lab => lab.simctl({ cmd: 'noise', rate: 0 }), []],
      [24, 'trunk loses 0.02% of bytes', 10, lab => lab.simctl({ cmd: 'drop', p: 0.0002 }), lab => lab.simctl({ cmd: 'drop', p: 0 }), []],
      [40, 'box cable pulled', 1, lab => lab.simctl({ cmd: 'cut', port: 0, on: true }), lab => lab.simctl({ cmd: 'cut', port: 0, on: false }), '*'],
    ],
    rate: async () => ['n/a', 0],
  },
  modbus: {
    lab: { kind: 'modbus', ips: 30, mb: { tcp: 6, gateways: 1, perGateway: 8, rtuOverTcp: 4, serial: 6, baud: 19200 }, ignorePoint: k => /\/holding:(25|26)\?/.test(k) },
    key: n => `modbus://${n}`,
    cycle: [
      [2, 'TCP device off', 5, ...F('tcp-03', 'offline'), ['tcp-03']],
      [9, 'TCP device reboots', 2, ...F('tcp-04', 'reboot', 60), ['tcp-04']],
      [12, '20% lost replies behind the gateway', 10, ...F('gw1-u05', 'drop', 0.2), []],
      [24, '5% network loss', 10, ...NET(0.05), []],
      [36, 'RS-485 noise 5 bytes/s', 10, lab => lab.simctl({ cmd: 'bus', noise: 5 }), lab => lab.simctl({ cmd: 'bus', noise: 0 }), []],
      [47, 'gateway off', 3, ...F('gw1', 'offline'), lab => lab.simInfo.devices.filter(d => d.conn.name === 'gw1').map(d => d.name)],
      [53, '10% garbage replies', 5, ...F('rs1-u02', 'garbage', 0.1), []],
    ],
    rate: async lab => { const st = await lab.simctl({ cmd: 'stats' }); const w = Object.entries(st.devices).sort((a, b) => b[1].max_rate - a[1].max_rate)[0]; return [w[0], w[1].max_rate, 12]; },
  },
  snmp: {
    // 99999.1.2.0 (text) and .5.0 (missing) are meant to error; v1 agents (every third) have no Counter64 (.3.0)
    lab: { kind: 'snmp', ips: 12, snmp: { agents: 6, v3: true }, ignorePoint: k => /99999\.1\.(2|5)\.0$/.test(k) || (/99999\.1\.3\.0$/.test(k) && /ups-0[36]\//.test(k)) },
    key: n => `snmp://${n}`,
    cycle: [
      [2, 'agent off', 5, ...F('ups-02', 'offline'), ['ups-02']],
      [9, 'agent reboots', 2, ...F('ups-04', 'reboot', 60), ['ups-04']],
      [12, '20% lost replies', 10, ...F('ups-01', 'drop', 0.2), []],
      [24, '5% network loss', 10, ...NET(0.05), []],
      [36, 'stale and duplicate replies', 10, lab => Promise.all([lab.simctl({ cmd: 'fault', dev: 'ups-03', f: 'stale', v: 0.3, on: true }), lab.simctl({ cmd: 'fault', dev: 'ups-05', f: 'dup', v: 0.3, on: true })]),
        lab => Promise.all([lab.simctl({ cmd: 'fault', dev: 'ups-03', f: 'stale', on: false }), lab.simctl({ cmd: 'fault', dev: 'ups-05', f: 'dup', on: false })]), []],
      [53, '10% garbage replies', 5, ...F('ups-06', 'garbage', 0.1), []],
    ],
    rate: async lab => { const st = await lab.simctl({ cmd: 'stats' }); const w = Object.entries(st.devices).sort((a, b) => b[1].max_rate - a[1].max_rate)[0]; return [w[0], w[1].max_rate, 7]; },
  },
  haystack: {
    lab: { kind: 'haystack', ips: 8, servers: 4, ignorePoint: k => /\.(bad|nan|noval)$/.test(k) }, key: n => `haystack://${n}`,
    cycle: [
      [2, 'server off', 5, ...F('hs-01', 'offline'), ['hs-01']],
      [12, '15% HTTP 500', 10, ...F('hs-02', 'err500', 0.15), []],
      [24, '5% network loss', 10, ...NET(0.05), []],
      [36, 'login tokens expire', 1, ...F('hs-03', 'expire'), []],
      [40, 'server hangs', 1, ...F('hs-04', 'hang'), ['hs-04']],
      [53, '10% broken replies', 5, ...F('hs-01', 'garbage', 0.1), []],
    ],
    rate: async lab => { const st = await lab.simctl({ cmd: 'stats' }); const w = Object.entries(st.servers).sort((a, b) => b[1].max_rate - a[1].max_rate)[0]; return [w[0], w[1].max_rate, 8]; },
  },
  obix: {
    lab: { kind: 'obix', ips: 6, servers: 3, ignorePoint: k => /Plant\/points\/(Faulty|Down|NaN)$/.test(k) }, key: n => `obix://${n}`,
    cycle: [
      [2, 'station off', 5, ...F('jace-01', 'offline'), ['jace-01']],
      [12, '15% HTTP 500', 10, ...F('jace-02', 'err500', 0.15), []],
      [24, '5% network loss', 10, ...NET(0.05), []],
      [40, 'station hangs', 1, ...F('jace-03', 'hang'), ['jace-03']],
      [53, '10% broken replies', 5, ...F('jace-01', 'garbage', 0.1), []],
    ],
    rate: async lab => { const st = await lab.simctl({ cmd: 'stats' }); const w = Object.entries(st.servers).sort((a, b) => b[1].max_rate - a[1].max_rate)[0]; return [w[0], w[1].max_rate, 8]; },
  },
};

async function main() {
  let st = load();
  const plan = PLANS[KIND];
  const lab = new Lab({ dir: DIR, dataDir: path.join(DIR, 'data'), interval: IV, tiny: true,
    ...(plan ? plan.lab : {}),
    net: arg('net', plan ? `bas-s${KIND.slice(0, 3)}` : 'bas-sim'), prefix: arg('prefix', plan ? `10.78.${20 + Object.keys(PLANS).indexOf(KIND)}` : '10.77.0'),
    webPort: Number(arg('web-port', 18770)) });
  lab.note = msg => { const l = `${new Date().toISOString()} ${msg}`; fs.appendFileSync(path.join(DIR, 'soak.log'), l + '\n'); };
  if (st && st.finished) { console.log('already finished; see', STATE); return; }
  if (!st) st = { start: now(), end: now() + HOURS * 3600000, faults: [], hourly: [], outages: [], done: {}, lastBeat: now(), restarts_expected: { box: 0, driver: 0 } };
  else {
    st.outages.push({ from: st.lastBeat, to: now() });
    st.faults.push({ device: '*', from: st.lastBeat, to: now() + 5 * MIN, why: 'test machine restart' });
    lab.note(`resuming after ${Math.round((now() - st.lastBeat) / 60000)} min away`);
  }
  lab.faults = st.faults;
  save(st);

  await lab.startSim();
  await lab.startServer({ persist: true });
  await lab.startBox({ faketime: true, overrides: { poll: { offline_retry_s: 120 }, upload: { every_s: 30, checkin_every_s: 60 } } });
  lab.note(`running until ${new Date(st.end).toISOString()}`);

  const boxPid = () => lab.box.pid;
  const rss = pid => { try { return Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024); } catch { return null; } };
  const drvPid = () => lab.driverPid();

  const active = new Map(); // key -> end time + undo
  const start = async (key, minutes, doFn, undoFn, device, why, extraAfter = 0) => {
    if (active.has(key) || st.done[key]) return;
    st.done[key] = true;
    const devs = Array.isArray(device) ? device : [device];
    const fs_ = devs.map(d => ({ device: d, from: now(), to: null, why }));
    st.faults.push(...fs_);
    const f = { set to(v) { fs_.forEach(x => { x.to = v + extraAfter; }); } };
    lab.note(`fault on: ${why}`);
    try { await doFn(); } catch (e) { lab.note(`fault ${why} failed to start: ${e.message}`); }
    active.set(key, { end: now() + minutes * MIN, undo: undoFn, f, why });
  };

  let lastHour = Math.floor((now() - st.start) / 3600000);
  while (now() < st.end) {
    // Stop at the segment end once no fault is running; the MS/TP plan can chain
    // faults for 22 minutes, so after a 15-minute wait end them and stop anyway
    // (the GitHub job would otherwise be killed by its time limit).
    if (now() > SEG_END && (!active.size || now() > SEG_END + 15 * MIN)) {
      for (const [key, a] of active) {
        try { await a.undo(); } catch (e) { lab.note(`undo ${a.why} failed: ${e.message}`); }
        a.f.to = now();
        active.delete(key);
        lab.note(`fault off (segment end): ${a.why}`);
      }
      st.lastBeat = now();
      save(st);
      lab.note('segment finished; the next run continues from here');
      await lab.stopBox('SIGTERM');
      await lab.close();
      return;
    }
    st.lastBeat = now();
    const el = now() - st.start;
    const hour = Math.floor(el / 3600000), minute = (el % 3600000) / MIN;
    // finish faults that are due
    for (const [key, a] of active) {
      if (now() >= a.end) {
        try { await a.undo(); } catch (e) { lab.note(`undo ${a.why} failed: ${e.message}`); }
        a.f.to = now();
        active.delete(key);
        lab.note(`fault off: ${a.why}`);
      }
    }
    // start faults due now
    for (const [m, label, mins, on, off, devs] of plan ? plan.cycle : []) {
      if (minute < m || minute > m + 1) continue;
      const list = typeof devs === 'function' ? devs(lab) : devs;
      const keys = list === '*' ? '*' : list.map(d => plan.key(d));
      await start(`${hour}:${label}`, mins, () => on(lab), () => off(lab), keys.length === 0 ? null : keys, label);
    }
    for (const [m, what, dev, mins, x] of plan ? [] : CYCLE) {
      if (minute < m || minute > m + 1) continue;
      const key = `${hour}:${what}`;
      const k = dev === '*' ? '*' : `bacnet://${dev}`;
      if (what === 'offline') await start(key, mins, () => lab.simctl({ cmd: 'offline', device: dev, on: true }), () => lab.simctl({ cmd: 'offline', device: dev, on: false }), k, `device ${dev} off`);
      if (what === 'reboot') await start(key, mins, () => lab.simctl({ cmd: 'reboot', device: dev, secs: mins * 60 }), async () => {}, k, `device ${dev} reboot`);
      if (what === 'drop') await start(key, mins, () => lab.simctl({ cmd: 'drop', device: dev, p: x }), () => lab.simctl({ cmd: 'drop', device: dev, p: 0 }), null, `${x * 100}% loss to ${dev}`);
      if (what === 'netloss') await start(key, mins, async () => lab.lossOn(x), async () => lab.lossOff(), null, `${x * 100}% network loss`);
      if (what === 'slow') await start(key, mins, () => lab.simctl({ cmd: 'slow', device: dev, secs: x, jitter: 1 }), () => lab.simctl({ cmd: 'slow', device: dev, secs: 0, jitter: 0 }), null, `device ${dev} slow`);
      if (what === 'error') await start(key, mins, () => lab.simctl({ cmd: 'error', device: dev, kind: 'error' }), () => lab.simctl({ cmd: 'error', device: dev, kind: null }), k, `device ${dev} errors`);
      if (what === 'odd') await start(key, mins, () => lab.simctl({ cmd: 'odd', device: dev, on: true }), () => lab.simctl({ cmd: 'odd', device: dev, on: false }), [1, 2, 3].map(i => `bacnet://${dev}/analog-input:${i}`), `device ${dev} odd values`);
      if (what === 'storm') await start(key, mins, () => lab.simctl({ cmd: 'storm', secs: 20, rate: 10 }), async () => {}, null, 'I-Am storm');
    }
    for (const [every, m, what, mins] of RARE) {
      if (hour % every !== every - 1 || minute < m || minute > m + 1) continue;
      const key = `${hour}:${what}`;
      if (what === 'server500') await start(key, mins, () => lab.srv('/mode', { mode: '500' }), () => lab.srv('/mode', { mode: 'ok' }), null, 'server errors');
      if (what === 'serverhang') await start(key, mins, () => lab.srv('/mode', { mode: 'hang' }), () => lab.srv('/mode', { mode: 'ok' }), null, 'server hangs');
      if (what === 'killdriver') await start(key, 3, async () => { st.restarts_expected.driver++; lab.killDriver(); }, async () => {}, '*', 'driver killed');
      if (what === 'killbox') await start(key, 2, async () => { st.restarts_expected.box++; await lab.stopBox('SIGKILL'); await sleep(mins * MIN); await lab.startBox({ faketime: true, overrides: { poll: { offline_retry_s: 120 }, upload: { every_s: 30, checkin_every_s: 60 } } }); }, async () => {}, '*', 'box killed');
      if (what === 'clock') await start(key, mins, async () => fs.writeFileSync(lab.ftFile, '+300'), async () => fs.writeFileSync(lab.ftFile, '+0'), '*', 'clock +5 min', 10 * MIN);
    }
    // the box must never stop by itself
    if (lab.boxExit && ![...active.keys()].some(k => k.endsWith('killbox'))) {
      st.unexpected = (st.unexpected || 0) + 1;
      lab.note(`BOX STOPPED BY ITSELF: ${JSON.stringify(lab.boxExit)}; restarting`);
      st.faults.push({ device: '*', from: now() - IV * 1000, to: now() + 3 * MIN, why: 'unexpected box stop' });
      await lab.startBox({ faketime: true, overrides: { poll: { offline_retry_s: 120 }, upload: { every_s: 30, checkin_every_s: 60 } } });
    }
    // hourly checks
    if (hour > lastHour) {
      lastHour = hour;
      const t1 = now() - 5 * MIN, t0 = t1 - 60 * MIN;
      const g = lab.gaps(t0, t1);
      const s = await lab.boxStatus();
      const h = { hour, at: new Date().toISOString(), gaps: g.length, gap_examples: g.slice(0, 3), box_rss_mb: rss(boxPid()), driver_rss_mb: rss(drvPid()),
        samples: lab.q('SELECT count(*) n FROM samples')[0].n, backlog: s?.destinations?.server?.backlog, driver_restarts: s?.health?.driver_restarts,
        poll: s?.poll, lanes_behind: s?.health?.lanes_behind };
      st.hourly.push(h);
      lab.note(`hour ${hour}: ${g.length} gaps, box ${h.box_rss_mb} MB, driver ${h.driver_rss_mb} MB`);
    }
    save(st);
    await sleep(10000);
  }
  // final checks
  for (const [, a] of active) { try { await a.undo(); } catch { /* */ } a.f.to = now(); }
  save(st);
  await sleep(3 * MIN);
  const loss = await lab.lossCheck();
  const g = lab.gaps(st.start + 10 * MIN, now() - 5 * MIN);
  const [dev, rate, limit = 6] = plan ? await plan.rate(lab) : lab.maxRate();
  st.final = { kind: KIND, loss, gaps: g.length, gap_examples: g.slice(0, 10), max_rate: [dev, rate], hours: HOURS,
    points: lab.q('SELECT count(*) n FROM points WHERE selected=1 AND missing=0')[0].n, samples: loss.box,
    outages: st.outages, unexpected_box_stops: st.unexpected || 0 };
  st.pass = loss.missing === 0 && loss.duplicates === 0 && loss.extra === 0 && g.length === 0 && !st.unexpected && (!limit || rate <= limit);
  st.finished = true;
  save(st);
  lab.note(`FINISHED: ${st.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(st.final).slice(0, 500)}`);
  await lab.close();
  process.exitCode = st.pass ? 0 : 2; // a failed soak fails the job that ran it
}

main().catch(e => { fs.appendFileSync(path.join(DIR, 'soak.log'), `${new Date().toISOString()} CRASH ${e.stack}\n`); process.exit(1); });
