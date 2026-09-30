'use strict';
// HEAPY Edge site box: finds BAS devices, reads their points on a schedule,
// buffers the readings and sends them to HEAPY Trend Tracker. Read-only to the BAS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Config } = require('./config');
const { Store } = require('./store');
const { DriverHost } = require('./driver-host');
const { Scanner } = require('./scanner');
const { Scheduler } = require('./scheduler');
const { Uploader } = require('./uploader');
const { Link } = require('./link');
const { Web } = require('./web');

const VERSION = require('../package.json').version;

// Passwords, keys and communities never go back to the browser.
const SECRET = /^(password|auth_key|priv_key|community|token)$/;
const MASK = '••••••••';
function maskSecrets(o) {
  if (Array.isArray(o)) o.forEach(maskSecrets);
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (SECRET.test(k) && typeof o[k] === 'string' && o[k]) o[k] = MASK; else maskSecrets(o[k]); }
}
// A masked value coming back from the page means "keep what is saved". Lists are matched by name.
function unmaskSecrets(neu, old) {
  if (Array.isArray(neu)) return neu.map((x, i) => unmaskSecrets(x, Array.isArray(old) ? (old.find(o => o && x && o.name !== undefined && o.name === x.name) || old[i]) : undefined));
  if (neu && typeof neu === 'object') {
    const out = {};
    for (const k of Object.keys(neu)) out[k] = neu[k] === MASK ? (old && old[k]) : unmaskSecrets(neu[k], old && old[k]);
    return out;
  }
  return neu;
}

class EdgeApp {
  constructor({ dataDir, overrides = {} }) {
    this.version = VERSION;
    this.dataDir = dataDir;
    this.config = new Config(dataDir, overrides);
    this.logs = [];
    this.logFile = path.join(dataDir, 'edge.log');
    this.store = new Store(path.join(dataDir, 'edge.db'));
    this.drivers = {};
    this.startedAt = Date.now();
    const settings = () => this.config.get();
    const log = (lvl, msg) => this.log(lvl, msg);
    this.scheduler = new Scheduler({
      store: this.store, drivers: this.drivers, settings, log,
      onDeviceChanged: (dev, why) => this.scanner.requestBrowse(dev, why),
      onStoreError: e => this.storeError(e),
    });
    this.scanner = new Scanner({ store: this.store, drivers: this.drivers, settings, log, onChange: () => this.scheduler.invalidate() });
    this.uploader = new Uploader({ store: this.store, settings, secret: () => this.config.secret(), log, boxInfo: () => this.boxInfo() });
    this.link = new Link({ config: this.config, store: this.store, log, health: () => this.health(), boxInfo: () => this.boxInfo(), onConfig: c => this.applyServerConfig(c) });
    this.web = new Web(this);
  }

  log(level, msg) {
    const line = { t: Date.now(), level, msg };
    this.logs.push(line);
    if (this.logs.length > 2000) this.logs.splice(0, 1000);
    const txt = `${new Date(line.t).toISOString()} ${level.toUpperCase()} ${msg}\n`;
    if (process.env.HEAPY_EDGE_QUIET !== '1') process.stdout.write(txt);
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 5e6) fs.renameSync(this.logFile, this.logFile + '.1');
      fs.appendFileSync(this.logFile, txt);
    } catch { /* disk issue shows in health */ }
  }

  // The buffer could not be written (disk full, disk error). Readings are being lost
  // until it clears: say so loudly, and free space by dropping readings the
  // server already has.
  storeError(e) {
    const now = Date.now();
    this.storeProblem = { t: now, msg: e.message };
    if (!this.lastStoreLog || now - this.lastStoreLog > 600000) {
      this.lastStoreLog = now;
      this.log('error', `cannot save readings: ${e.message}`);
    }
    if (/full|SQLITE_FULL|disk/i.test(e.message)) {
      try {
        const n = this.uploader.emergencyPrune();
        if (n) this.log('warn', `disk full: removed ${n} readings the server already has`);
      } catch { /* nothing more to do */ }
    }
  }

  boxInfo() {
    const sec = this.config.secret();
    return {
      box_id: sec.box_id || null, name: this.config.get().name, version: VERSION, hardware: this.config.get().hardware,
      drivers: Object.entries(this.drivers).map(([n, h]) => `${n}@${h.info?.version || '?'}`),
    };
  }

  health() {
    const c = this.store.counts();
    let free = null;
    try { const st = fs.statfsSync(this.dataDir); free = Math.round(st.bavail * st.bsize / 1048576); } catch { /* old node */ }
    const dests = this.uploader.health();
    const srv = dests.server;
    const lastErr = [...this.logs].reverse().find(l => l.level === 'error');
    const st = this.scheduler.stats;
    return {
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000), backlog_samples: srv && srv.enabled ? srv.backlog : null,
      devices_error: c.error, duplicate_ids: c.duplicates, points_with_errors: c.point_errors,
      store_problem: this.storeProblem && Date.now() - this.storeProblem.t < 600000 ? this.storeProblem.msg : null,
      clock_jumps: st.clock_jumps, lanes_behind: this.scheduler.lanesBehind(), driver_restarts: Object.values(this.drivers).reduce((n, h) => n + h.restarts, 0),
      oldest_unsent_ms: srv && srv.enabled ? srv.oldest_unsent : null, devices: c.devices, devices_offline: c.offline,
      points: c.points, selected: c.selected, late_points: this.store.latePoints(), disk_free_mb: free,
      buffer_mb: Math.round(this.store.sizeMb()), last_error: lastErr ? lastErr.msg : null,
    };
  }

  status() {
    const sec = this.config.secret();
    return {
      name: this.config.get().name, version: VERSION, started: this.startedAt, host: os.hostname(),
      health: this.health(), scan: this.scanner.state, poll: this.scheduler.stats,
      drivers: Object.fromEntries(Object.entries(this.drivers).map(([n, h]) => [n, { ready: h.ready, version: h.info?.version, restarts: h.restarts, warnings: (h.configured && h.configured.warnings) || [] }])),
      destinations: this.uploader.health(),
      link: { paired: !!sec.key, box_id: sec.box_id || null, site: sec.site || null, server: sec.server || null, ...this.link.state },
    };
  }

  // Settings for the setup page: program paths removed, passwords and keys masked.
  publicSettings() {
    const s = JSON.parse(JSON.stringify(this.config.get()));
    for (const d of Object.values(s.drivers)) { delete d.cmd; maskSecrets(d.settings); }
    return s;
  }

  // Changes from the setup page. Only these parts can be changed there.
  async applySettings(patch) {
    const allowed = ['name', 'drivers', 'scan', 'poll', 'upload', 'buffer', 'destinations'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    if (clean.drivers) {
      for (const [n, d] of Object.entries(clean.drivers)) {
        if (!this.config.get().drivers[n]) { delete clean.drivers[n]; continue; } // only drivers the box has
        delete d.cmd; // program paths are never set from the page
        if (d.settings) d.settings = unmaskSecrets(d.settings, this.config.get().drivers[n].settings); // masked = unchanged
      }
    }
    if (clean.destinations) {
      const cur = this.config.get().destinations;
      clean.destinations = cur.map(d => {
        const n = clean.destinations.find(x => x.name === d.name);
        if (!n) return d;
        const out = { ...d, enabled: !!n.enabled };
        if (d.type === 'file' && n.dir) out.dir = String(n.dir);
        return out; // server url is only set by pairing
      });
    }
    const before = JSON.stringify(this.config.get().drivers);
    this.config.update(clean);
    this.scheduler.invalidate();
    if (JSON.stringify(this.config.get().drivers) !== before) {
      const names = new Set([...Object.keys(this.drivers), ...Object.keys(this.config.get().drivers)]);
      for (const name of names) {
        const was = JSON.stringify(JSON.parse(before)[name] || null), now = JSON.stringify(this.config.get().drivers[name] || null);
        if (was !== now || (this.config.get().drivers[name]?.enabled && !this.drivers[name])) await this.restartDriver(name);
      }
      this.scanner.state.last_error = null;
      // connections changed: find their devices now rather than at the next scheduled scan
      setTimeout(() => this.scanner.run('settings changed').then(() => this.scheduler.invalidate()).catch(() => {}), 2000);
    }
    this.log('info', `settings changed: ${Object.keys(clean).join(', ')}`);
  }

  // Settings pushed by Trend Tracker at check-in: point choices, intervals, scan windows.
  async applyServerConfig(c) {
    if (Array.isArray(c.points)) { this.store.updatePoints(c.points); this.scheduler.invalidate(); }
    const patch = {};
    for (const k of ['scan', 'poll', 'upload', 'buffer', 'name']) if (c[k] !== undefined) patch[k] = c[k];
    if (Object.keys(patch).length) await this.applySettings(patch);
    if (c.scan_now) this.scanner.run('server').then(() => this.scheduler.invalidate()).catch(() => {});
  }

  async startDriver(name, cfg) {
    const host = new DriverHost(name, cfg, (l, m) => this.log(l, m));
    host.on('cov', d => this.scheduler.onCov(d));
    host.on('iam', d => this.scheduler.onAnnounce(name, d));
    host.on('ready', () => this.scheduler.resetCov(name));
    this.drivers[name] = host;
    try { await host.start(); } catch (e) { this.log('error', `${name} driver did not start: ${e.message}`); }
  }
  async restartDriver(name) {
    const old = this.drivers[name];
    if (old) { await old.stop(); delete this.drivers[name]; }
    const cfg = this.config.get().drivers[name];
    if (cfg && cfg.enabled) await this.startDriver(name, cfg);
  }

  async start() {
    this.log('info', `HEAPY Edge ${VERSION} starting (data in ${this.dataDir})`);
    await this.web.start();
    for (const [name, cfg] of Object.entries(this.config.get().drivers)) if (cfg.enabled) await this.startDriver(name, cfg);
    this.scheduler.start();
    this.timers = [
      setInterval(() => this.scanner.tick(), 10000),
      setInterval(() => this.uploader.tick().catch(e => this.log('error', `upload: ${e.message}`)), 1000),
      setInterval(() => this.link.tick().catch(() => {}), 5000),
      setInterval(() => this.scheduler.covTick().catch(() => {}), 15000),
    ];
    setTimeout(() => this.scanner.tick(), 1000);
    return this;
  }

  async stop() {
    for (const t of this.timers || []) clearInterval(t);
    await this.scheduler.stop();
    for (const h of Object.values(this.drivers)) await h.stop();
    await this.web.stop();
    try { await this.uploader.tick(true); } catch { /* best effort */ }
    this.store.close();
  }
}

if (require.main === module) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const dataDir = path.resolve(arg('--data') || process.env.HEAPY_EDGE_DATA || path.join(__dirname, '..', 'data'));
  // --overrides file.json: fixed settings for this run (tests, special installs)
  const ov = arg('--overrides') || process.env.HEAPY_EDGE_OVERRIDES;
  const overrides = ov ? JSON.parse(fs.readFileSync(ov, 'utf8')) : {};
  const app = new EdgeApp({ dataDir, overrides });
  app.start().catch(e => { console.error(e); process.exit(1); });
  const bye = () => { app.log('info', 'stopping'); app.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  // never die silently: log it, and let the service manager restart us
  process.on('uncaughtException', e => { try { app.log('error', `crash: ${e.stack || e}`); } catch { /* */ } process.exit(1); });
  process.on('unhandledRejection', e => { try { app.log('error', `unhandled: ${e && e.stack || e}`); } catch { /* */ } });
}

module.exports = { EdgeApp, maskSecrets, unmaskSecrets, MASK };
