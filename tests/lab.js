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
    this.o = { ahus: 6, vavs: 25, trunks: 2, vavsPerTrunk: 25, extraIp: 0, big: 0, tiny: false, interval: 15, ips: 40, net: 'bas-sim', prefix: '10.77.0', kind: 'bacnet-ip', devices: 10, link: '10.255.77', ...opts };
    this.driverName = { mstp: 'bacnet-mstp', modbus: 'modbus', snmp: 'snmp', haystack: 'haystack', obix: 'obix' }[this.o.kind] || 'bacnet-ip';
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
    if (this.o.kind === 'mstp') return this.startMstpSim();
    if (this.o.kind === 'modbus') return this.startModbusSim();
    if (this.o.kind === 'snmp') return this.startSnmpSim();
    if (this.o.kind === 'haystack') return this.startHaystackSim();
    if (this.o.kind === 'obix') return this.startWebSim('obix_sim.py', ['--stations', String(this.o.servers || 2)]);
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

  async startMstpSim() {
    this.sim = spawn('python3', [path.join(ROOT, 'sim', 'mstp_site.py'), '--devices', String(this.o.devices), '--control', this.sock],
      { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    const line = await new Promise((res, rej) => {
      this.sim.stdout.once('data', d => res(String(d)));
      this.sim.once('exit', c => rej(new Error('MS/TP simulator stopped ' + c)));
    });
    this.simInfo = JSON.parse(line.trim().split('\n')[0]);
    this.note(`MS/TP trunk: ${this.simInfo.devices} devices, box port ${this.simInfo.box_port}`);
    return this.simInfo;
  }

  // Modbus site: TCP devices, gateways, an RTU-over-TCP server and an RS-485 bus.
  // mb: { tcp, gateways, perGateway, rtuOverTcp, serial, baud, big, tiny }
  async startModbusSim() {
    const o = this.o, mb = { tcp: 6, gateways: 1, perGateway: 8, rtuOverTcp: 4, serial: 6, baud: 19200, ...(o.mb || {}) };
    execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(o.ips), o.net, o.prefix], { stdio: 'ignore' });
    const args = [path.join(ROOT, 'sim', 'modbus_sim.py'), '--base', `${o.prefix}.`, '--tcp', mb.tcp, '--gateways', mb.gateways,
      '--per-gateway', mb.perGateway, '--rtu-over-tcp', mb.rtuOverTcp, '--serial', mb.serial, '--baud', mb.baud,
      '--control', this.sock, '--stats', this.statsFile].map(String);
    if (mb.big) args.push('--big');
    if (mb.tiny) args.push('--tiny');
    this.sim = spawn('ip', ['netns', 'exec', o.net, 'python3', ...args], { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    let buf = '';
    const line = await new Promise((res, rej) => {
      this.sim.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf.split('\n')[0]); });
      this.sim.once('exit', c => rej(new Error('Modbus simulator stopped ' + c)));
    });
    this.simInfo = JSON.parse(line);
    const tpl = p => JSON.parse(execFileSync('python3', [path.join(ROOT, 'sim', 'modbus_sim.py'), '--template', p]).toString());
    this.mbTemplates = { meter: tpl('meter'), big: tpl('big') };
    this.note(`Modbus site: ${this.simInfo.devices.length} devices`);
    return this.simInfo;
  }

  // SNMP site: v2c and v1 agents written for the lab, plus a v3 agent (snmpsim)
  async startSnmpSim() {
    const o = this.o, sn = { agents: 6, v3: true, ...(o.snmp || {}) };
    execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(o.ips), o.net, o.prefix], { stdio: 'ignore' });
    const args = [path.join(ROOT, 'sim', 'snmp_sim.py'), '--base', `${o.prefix}.`, '--agents', String(sn.agents), '--control', this.sock];
    if (sn.v3) args.push('--v3');
    this.sim = spawn('ip', ['netns', 'exec', o.net, 'python3', ...args], { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    let buf = '';
    const line = await new Promise((res, rej) => {
      this.sim.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf.split('\n')[0]); });
      this.sim.once('exit', c => rej(new Error('SNMP simulator stopped ' + c)));
    });
    this.simInfo = JSON.parse(line);
    this.snmpExpected = JSON.parse(execFileSync('python3', [path.join(ROOT, 'sim', 'snmp_sim.py'), '--print-expected']).toString());
    this.note(`SNMP site: ${this.simInfo.devices.length} agents`);
    return this.simInfo;
  }

  async startWebSim(script, extra) {
    const o = this.o;
    execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(o.ips), o.net, o.prefix], { stdio: 'ignore' });
    const args = [path.join(ROOT, 'sim', script), '--base', `${o.prefix}.`, ...extra, '--control', this.sock];
    this.sim = spawn('ip', ['netns', 'exec', o.net, 'python3', ...args], { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    let buf = '';
    const line = await new Promise((res, rej) => {
      this.sim.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf.split('\n')[0]); });
      this.sim.once('exit', c => rej(new Error(`${script} stopped ${c}`)));
    });
    this.simInfo = JSON.parse(line);
    this.expected = JSON.parse(execFileSync('python3', [path.join(ROOT, 'sim', script), '--print-expected']).toString()).expected;
    this.note(`${script}: ${this.simInfo.devices.length} servers`);
    return this.simInfo;
  }

  async startHaystackSim() {
    const o = this.o;
    execFileSync(path.join(ROOT, 'sim', 'netsetup.sh'), [String(o.ips), o.net, o.prefix], { stdio: 'ignore' });
    const args = [path.join(ROOT, 'sim', 'haystack_sim.py'), '--base', `${o.prefix}.`, '--servers', String(o.servers || 4), '--control', this.sock];
    this.sim = spawn('ip', ['netns', 'exec', o.net, 'python3', ...args], { stdio: ['ignore', 'pipe', fs.openSync(path.join(this.dir, 'sim.log'), 'a')] });
    this.procs.push(this.sim);
    let buf = '';
    const line = await new Promise((res, rej) => {
      this.sim.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf.split('\n')[0]); });
      this.sim.once('exit', c => rej(new Error('Haystack simulator stopped ' + c)));
    });
    this.simInfo = JSON.parse(line);
    this.hsExpected = JSON.parse(execFileSync('python3', [path.join(ROOT, 'sim', 'haystack_sim.py'), '--print-expected']).toString()).expected;
    this.note(`Haystack site: ${this.simInfo.devices.length} servers`);
    return this.simInfo;
  }

  snmpSettings() {
    const devices = this.simInfo.devices.map(d => {
      const dv = { name: d.name, host: d.host, port: d.port, version: d.version, template: 'ups-mib',
        points: [{ name: 'sysUpTime', oid: '1.3.6.1.2.1.1.3.0', scale: 0.01 }, ...this.snmpExpected.extra_points], ...(this.o.devOpts || {}) };
      if (d.v3) dv.v3 = d.v3; else dv.community = d.community;
      return dv;
    });
    return { devices };
  }

  modbusSettings() {
    const conns = new Map();
    const devices = this.simInfo.devices.map(d => {
      conns.set(d.conn.name, { ...d.conn, ...(this.o.connOpts || {}) });
      return { name: d.name, connection: d.conn.name, unit: d.unit, template: d.profile === 'big' ? 'big' : 'meter' };
    });
    return { connections: [...conns.values()], devices,
      templates: { meter: { points: this.mbTemplates.meter.points }, big: { points: this.mbTemplates.big.points } } };
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
    const drivers = this.o.kind === 'mstp' ? {
      'bacnet-ip': { enabled: false },
      'bacnet-mstp': { enabled: true, cmd: ['python3', path.join(ROOT, 'drivers', 'bacnet-mstp', 'driver.py')], rate_per_device: 5, discover_timeout_s: 4,
        settings: { serial: this.simInfo.box_port, router: path.join(ROOT, 'bin', 'router-mstp'), link: this.o.link, instance: 4194003 } },
    } : this.o.kind === 'obix' ? {
      'bacnet-ip': { enabled: false },
      obix: { enabled: true, rate_per_device: 5, settings: { stations: this.simInfo.devices.map(d => ({ ...d, timeout_ms: 5000 })) } },
    } : this.o.kind === 'haystack' ? {
      'bacnet-ip': { enabled: false },
      haystack: { enabled: true, rate_per_device: 5, settings: { servers: this.simInfo.devices.map(d => ({ name: d.name, url: d.url, user: d.user, password: d.password, auth: d.auth, timeout_ms: 5000 })) } },
    } : this.o.kind === 'snmp' ? {
      'bacnet-ip': { enabled: false },
      snmp: { enabled: true, rate_per_device: 5, settings: this.snmpSettings() },
    } : this.o.kind === 'modbus' ? {
      'bacnet-ip': { enabled: false },
      modbus: { enabled: true, rate_per_device: 10, settings: this.modbusSettings() },
    } : { 'bacnet-ip': { settings: { address: `${this.o.prefix}.2/24`, instance: 4194001 }, rate_per_device: 5, discover_timeout_s: 3 } };
    return deepMerge({
      web: { port: this.o.webPort || 18770, bind: '127.0.0.1' },
      drivers,
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
    if (wait) await this.waitFor(async () => (await this.boxStatus())?.drivers?.[this.driverName]?.ready, 90000, 'box start');
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
  // Every reading slot of every selected point must hold a reading. The box reads each
  // point once per interval in clock-aligned slots (with a fixed per-device offset, the
  // same one the scheduler uses); a slot with no reading that no recorded fault explains
  // is a gap. Late readings inside their own slot are fine; a missed slot never hides
  // behind a late neighbour.
  gaps(t0, t1, { slack = 0 } = {}) {
    const iv = this.o.interval * 1000;
    const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
    const rows = this.q(`SELECT p.id, s.t FROM samples s JOIN points p ON p.id=s.p
      WHERE p.selected=1 AND p.missing=0 AND s.t BETWEEN ? AND ? ORDER BY p.id, s.t`, t0 - iv, t1 + iv);
    const byPoint = new Map();
    for (const r of rows) { if (!byPoint.has(r.id)) byPoint.set(r.id, []); byPoint.get(r.id).push(r.t); }
    const pts = this.q(`SELECT p.id, p.key, d.key dkey, p.created_at FROM points p JOIN devices d ON d.id=p.device_id WHERE p.selected=1 AND p.missing=0`);
    const bad = [];
    const explained = (dkey, pkey, a, b) => this.faults.some(f => (f.device === '*' || f.device === dkey || f.device === pkey) && f.from - iv * 2 <= b && (f.to ?? Date.now()) + slack + iv * 3 >= a);
    for (const p of pts) {
      if (this.o.ignorePoint && this.o.ignorePoint(p.key)) continue;
      const ts = byPoint.get(p.id) || [];
      const off = hash(p.dkey) % Math.min(iv, 30000);
      // a point found during the run counts from its first full slot
      const start = Math.max(t0, (p.created_at || 0) + iv);
      let s = Math.floor((start - off) / iv) * iv + off + iv;
      let i = 0, run = null;
      for (; s + iv <= t1; s += iv) {
        while (i < ts.length && ts[i] < s) i++;
        const hit = i < ts.length && ts[i] < s + iv;
        if (!hit && !explained(p.dkey, p.key, s, s + iv)) {
          if (run && run.to === s) { run.to = s + iv; run.gap_s += iv / 1000; } else { run = { point: p.key, from: s, to: s + iv, gap_s: iv / 1000 }; bad.push(run); }
        }
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
  lossOn(p, proto = this.o.kind === 'modbus' ? 'tcp' : 'udp') { this.lossRule = `INPUT -i ${this.br} -p ${proto} -m statistic --mode random --probability ${p} -j DROP`; execSync(`iptables -I ${this.lossRule}`); }
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
