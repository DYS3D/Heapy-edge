'use strict';
// Stress lab: runs the simulated BACnet site, a stand-in Trend Tracker server and
// the box as a real separate process, so faults can be injected anywhere
// (devices, network, driver, box process, server, disk, clock).
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync, execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAKETIME_LIB = '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1';

class Lab {
  constructor(opts = {}) {
    this.o = { ahus: 6, vavs: 25, trunks: 2, vavsPerTrunk: 25, extraIp: 0, big: 0, tiny: false, interval: 15, ips: 40, net: 'bas-sim', prefix: '10.77.0', ...opts };
    this.br = this.o.net === 'bas-sim' ? 'br-bas' : `br-${this.o.net.replace(/^bas-/, '')}`;
    this.dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'edge-lab-'));
    fs.mkdirSync(this.dir, { recursive: true });
    this.sock = path.join(this.dir, 'sim.sock');
    this.statsFile = path.join(this.dir, 'sim-stats.json');
    this.dataDir = opts.dataDir || path.join(this.dir, 'data');
    this.faults = [];      // { device (key or '*'), from, to, why }
    this.log = [];
    this.procs = [];
  }

  note(msg) { const l = `${new Date().toISOString().slice(11, 19)} ${msg}`; this.log.push(l); if (!process.env.LAB_QUIET) console.log('   ' + l); }

  // ---- simulator ----
  async startSim() {
    execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(this.o.ips), this.o.net, this.o.prefix], { stdio: 'ignore' });
    const o = this.o;
    const args = [path.join(ROOT, 'sim', 'bacnet_sim.py'), '--ahus', o.ahus, '--vavs', o.vavs, '--trunks', o.trunks,
      '--vavs-per-trunk', o.vavsPerTrunk, '--extra-ip', o.extraIp, '--big', o.big, '--control', this.sock,
      '--stats', this.statsFile, '--tick', '2', '--base', `${o.prefix}.`].map(String);
    if (o.tiny) args.push('--tiny');
    this.sim = spawn('ip', ['netns', 'exec', o.net, 'python3', ...args], { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    const line = await new Promise((res, rej) => {
      this.sim.stdout.once('data', d => res(String(d)));
      this.sim.once('exit', c => rej(new Error('simulator stopped ' + c)));
    });
    this.simInfo = JSON.parse(line.trim().split('\n')[0]);
    this.note(`simulator: ${this.simInfo.devices} devices`);
    return this.simInfo;
  }

  simctl(cmd) {
    return new Promise((resolve, reject) => {
      const c = net.createConnection(this.sock);
      let buf = '';
      c.on('connect', () => c.write(JSON.stringify(cmd) + '\n'));
      c.on('data', d => { buf += d; if (buf.endsWith('\n')) { c.end(); try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } } });
      c.on('error', reject);
      setTimeout(() => { c.destroy(); reject(new Error('simctl timeout')); }, 30000);
    });
  }
  simStats() { try { return JSON.parse(fs.readFileSync(this.statsFile, 'utf8')); } catch { return {}; } }

  // ---- stand-in server ----
  async startServer({ persist = false } = {}) {
    // port and key stay the same across restarts of a long test
    const kf = path.join(this.dir, 'server.json');
    const saved = fs.existsSync(kf) ? JSON.parse(fs.readFileSync(kf, 'utf8')) : null;
    this.port = saved?.port || 8800 + Math.floor(Math.random() * 400);
    this.key = saved?.key || crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(kf, JSON.stringify({ port: this.port, key: this.key }));
    const args = [path.join(__dirname, 'mock-intake.js'), String(this.port), this.key];
    if (persist) args.push('--persist', path.join(this.dir, 'server-received.log'));
    this.server = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.procs.push(this.server);
    await new Promise(r => this.server.stdout.once('data', r));
    this.url = `http://127.0.0.1:${this.port}`;
  }
  async srv(p, body) {
    const r = await fetch(this.url + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return r.json();
  }

  // ---- box ----
  boxOverrides(extra = {}) {
    const iv = this.o.interval;
    return deepMerge({
      web: { port: this.o.webPort || 18770, bind: '127.0.0.1' },
      drivers: { 'bacnet-ip': { settings: { address: `${this.o.prefix}.2/24`, instance: 4194001 }, rate_per_device: 5, discover_timeout_s: 3 } },
      scan: { at_start: true, every_h: 1000, windows: ['any'] },
      poll: { default_interval_s: iv, offline_after: 3, offline_retry_s: 20 },
      upload: { every_s: 5, checkin_every_s: 10, permanent_retry_s: 30, max_retry_s: 20 },
      destinations: [{ name: 'server', type: 'https', url: this.url, enabled: true }],
    }, extra);
  }

  async startBox({ overrides = {}, faketime = false, wait = true } = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const sec = path.join(this.dataDir, 'secret.json');
    const cur = fs.existsSync(sec) ? JSON.parse(fs.readFileSync(sec, 'utf8')) : {};
    fs.writeFileSync(sec, JSON.stringify({ ...cur, box_id: 'box-test', key: this.key, server: this.url }), { mode: 0o600 });
    const ovFile = path.join(this.dir, 'overrides.json');
    fs.writeFileSync(ovFile, JSON.stringify(this.boxOverrides(overrides)));
    const env = { ...process.env, HEAPY_EDGE_QUIET: '1', NODE_NO_WARNINGS: '1' };
    if (faketime) {
      this.ftFile = path.join(this.dir, 'faketime.txt');
      if (!fs.existsSync(this.ftFile)) fs.writeFileSync(this.ftFile, '+0');
      Object.assign(env, { LD_PRELOAD: FAKETIME_LIB, FAKETIME_TIMESTAMP_FILE: this.ftFile, FAKETIME_CACHE_DURATION: '1', FAKETIME_DONT_FAKE_MONOTONIC: '1' });
    }
    this.box = spawn(process.execPath, [path.join(ROOT, 'core', 'main.js'), '--data', this.dataDir, '--overrides', ovFile],
      { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(this.dir, 'box.err'), 'a')] });
    this.procs.push(this.box);
    this.boxExit = null;
    this.box.once('exit', (c, sig) => { this.boxExit = { code: c, sig }; });
    if (wait) await this.waitFor(async () => (await this.boxStatus())?.drivers?.['bacnet-ip']?.ready, 60000, 'box start');
  }

  async stopBox(signal = 'SIGTERM') {
    if (!this.box || this.boxExit) return;
    const done = new Promise(r => this.box.once('exit', r));
    this.box.kill(signal);
    await Promise.race([done, sleep(40000)]);
  }

  // setup page API (signs in first time)
  async api(p, body) {
    const base = `http://127.0.0.1:${this.o.webPort || 18770}/api/`;
    const call = async () => {
      const r = await fetch(base + p, body === undefined ? { headers: { cookie: this.cookie || '' } } :
        { method: 'POST', headers: { cookie: this.cookie || '', 'content-type': 'application/json', 'x-edge': '1' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null), sc: r.headers.get('set-cookie') };
    };
    let r = await call();
    if (r.status === 401) {
      const pw = 'lab-password-123';
      const f = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-edge': '1' }, body: JSON.stringify(b) });
      let l = await f('setup-password', { password: pw });
      if (l.status !== 200) l = await f('login', { password: pw });
      this.cookie = (l.headers.get('set-cookie') || '').split(';')[0];
      r = await call();
    }
    return r.body;
  }
  async boxStatus() { try { return await this.api('status'); } catch { return null; } }

  // read-only look into the box's buffer
  q(sql, ...args) {
    const db = new DatabaseSync(path.join(this.dataDir, 'edge.db'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  }
  device(key) { return this.q('SELECT * FROM devices WHERE key=?', key)[0]; }

  async waitFor(fn, ms, what = 'condition', step = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch { /* keep trying */ }
      await sleep(step);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  fault(device, from, to, why) { this.faults.push({ device, from, to, why }); }

  // ---- checks ----
  // Every gap between readings of a selected point longer than 1.5 intervals
  // that no recorded fault explains.
  gaps(t0, t1, { slack = 0 } = {}) {
    const iv = this.o.interval * 1000;
    const rows = this.q(`SELECT p.id, p.key, d.key dkey, s.t FROM samples s JOIN points p ON p.id=s.p JOIN devices d ON d.id=p.device_id
      WHERE p.selected=1 AND p.missing=0 AND s.t BETWEEN ? AND ? ORDER BY p.id, s.t`, t0, t1);
    const byPoint = new Map();
    for (const r of rows) { if (!byPoint.has(r.id)) byPoint.set(r.id, { key: r.key, dkey: r.dkey, ts: [] }); byPoint.get(r.id).ts.push(r.t); }
    const pts = this.q(`SELECT p.id, p.key, d.key dkey, p.created_at FROM points p JOIN devices d ON d.id=p.device_id WHERE p.selected=1 AND p.missing=0`);
    const bad = [];
    const explained = (dkey, pkey, a, b) => this.faults.some(f => (f.device === '*' || f.device === dkey || f.device === pkey) && f.from - iv * 2 <= b && (f.to ?? Date.now()) + slack + iv * 3 >= a);
    for (const p of pts) {
      const e = byPoint.get(p.id) || { ts: [] };
      // a point found during the run starts counting when it was found
      const start = Math.max(t0, (p.created_at || 0) + iv);
      const ts = [start, ...e.ts.filter(x => x >= start), t1];
      for (let i = 1; i < ts.length; i++) {
        const g = ts[i] - ts[i - 1];
        if (g > 1.5 * iv + 2000 && !explained(p.dkey, p.key, ts[i - 1], ts[i])) bad.push({ point: p.key, from: ts[i - 1], to: ts[i], gap_s: Math.round(g / 1000) });
      }
    }
    return bad;
  }

  // Everything in the buffer reached the server exactly once, and nothing else did.
  async lossCheck() {
    // readings keep arriving, so compare everything the server has confirmed
    // (ids up to the destination's last_id); wait until that covers nearly all
    await this.waitFor(async () => { const s = await this.boxStatus(); return s && s.destinations.server.backlog < 3000 && !s.destinations.server.last_error; }, 240000, 'backlog to drain', 2000);
    await sleep(8000);
    const upto = this.q("SELECT last_id FROM dest_state WHERE name='server'")[0].last_id;
    const seen = new Set(await this.srv('/seen'));
    const box = this.q('SELECT p.key, s.t FROM samples s JOIN points p ON p.id=s.p WHERE s.id<=?', upto).map(r => `${r.key}@${r.t}`);
    const later = new Set(this.q('SELECT p.key, s.t FROM samples s JOIN points p ON p.id=s.p WHERE s.id>?', upto).map(r => `${r.key}@${r.t}`));
    const boxSet = new Set(box);
    const missing = box.filter(k => !seen.has(k));
    let extra = 0;
    for (const k of seen) if (!boxSet.has(k) && !later.has(k)) extra++;
    const st = await this.srv('/stats');
    return { box: box.length, server: seen.size, missing: missing.length, extra, duplicates: st.dup, box_dup_rows: box.length - boxSet.size };
  }

  // unexplained gaps for one device (or one point) in a window
  devGaps(key, t0, t1) { return this.gaps(t0, t1).filter(g => g.point === key || g.point.startsWith(key + '/')); }

  maxRate() {
    const s = this.simStats();
    let worst = ['', 0];
    for (const [k, v] of Object.entries(s)) if (v.max_rate > worst[1]) worst = [k, v.max_rate];
    return worst;
  }

  iptables(args) { execSync(`iptables ${args}`); }
  // packet loss on this lab's BAS network only
  lossOn(p) { this.lossRule = `INPUT -i ${this.br} -p udp -m statistic --mode random --probability ${p} -j DROP`; execSync(`iptables -I ${this.lossRule}`); }
  lossOff() { if (this.lossRule) { try { execSync(`iptables -D ${this.lossRule}`); } catch { /* gone */ } this.lossRule = null; } }
  // this lab's driver process only
  killDriver() { execSync(`pkill -9 -P ${this.box.pid} -f "[d]rivers/"`); }
  driverPid() { try { return Number(execSync(`pgrep -P ${this.box.pid} -f "[d]rivers/"`).toString().trim().split('\n')[0]); } catch { return null; } }

  async close() {
    this.lossOff();
    try { if (this.box) execSync(`pkill -9 -P ${this.box.pid}`, { stdio: 'ignore' }); } catch { /* */ }
    for (const p of this.procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
    await sleep(500);
  }
}

function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || !b) return b === undefined ? a : b;
  const out = { ...(a || {}) };
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

module.exports = { Lab, sleep, ROOT };
