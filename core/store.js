'use strict';
// HEAPY Edge local buffer: devices, points and samples in one SQLite file.
// Samples stay until every enabled destination has confirmed them and they
// are older than keep_days.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS devices (
     id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, driver TEXT NOT NULL,
     route TEXT, name TEXT, vendor TEXT, model TEXT, meta TEXT,
     first_seen INTEGER, last_seen INTEGER, browsed_at INTEGER,
     status TEXT DEFAULT 'new', fails INTEGER DEFAULT 0, retry_at INTEGER DEFAULT 0,
     last_error TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS points (
     id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, device_id INTEGER NOT NULL,
     name TEXT, description TEXT, units TEXT, kind TEXT, states TEXT, cov INTEGER DEFAULT 0,
     selected INTEGER DEFAULT 1, interval_s INTEGER DEFAULT 900, cov_active INTEGER DEFAULT 0,
     last_t INTEGER, last_v REAL, last_error TEXT, missing INTEGER DEFAULT 0, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS points_dev ON points(device_id)`,
  `CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, p INTEGER NOT NULL, t INTEGER NOT NULL, v REAL)`,
  `CREATE INDEX IF NOT EXISTS samples_t ON samples(t)`,
  `CREATE TABLE IF NOT EXISTS dest_state (
     name TEXT PRIMARY KEY, last_id INTEGER DEFAULT 0, seq INTEGER DEFAULT 0, meta_t INTEGER DEFAULT 0,
     pending TEXT, last_ok INTEGER, last_error TEXT, fails INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0)`,
];

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    for (const s of SCHEMA) this.db.exec(s);
    // migrations for buffers made by older versions
    const cols = new Set(this.db.prepare('PRAGMA table_info(points)').all().map(c => c.name));
    if (!cols.has('created_at')) this.db.exec('ALTER TABLE points ADD COLUMN created_at INTEGER');
    this.q = {};
  }
  prep(sql) { return this.q[sql] || (this.q[sql] = this.db.prepare(sql)); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) {
      // SQLite may already have rolled back (e.g. disk full): keep the real error
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }
  getMeta(k, d = null) { const r = this.prep('SELECT v FROM meta WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; }
  setMeta(k, v) { this.prep('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }

  // ---- devices ----
  upsertDevice(driver, d) {
    const now = Date.now();
    const old = this.prep('SELECT * FROM devices WHERE key=?').get(d.key);
    const meta = JSON.stringify(d.meta || {});
    if (!old) {
      this.prep(`INSERT INTO devices(key,driver,route,name,vendor,model,meta,first_seen,last_seen,status,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,'new',?)`).run(d.key, driver, d.route, d.name, d.vendor ?? null, d.model ?? null, meta, now, now, now);
      return { created: true, device: this.device(d.key) };
    }
    const changed = old.route !== d.route || old.name !== d.name || old.vendor !== (d.vendor ?? null) ||
      old.model !== (d.model ?? null) || old.meta !== meta;
    this.prep(`UPDATE devices SET route=?,name=?,vendor=?,model=?,meta=?,last_seen=?${changed ? ',updated_at=' + now : ''} WHERE key=?`)
      .run(d.route, d.name, d.vendor ?? null, d.model ?? null, meta, now, d.key);
    return { created: false, changed, device: this.device(d.key) };
  }
  device(key) { const r = this.prep('SELECT * FROM devices WHERE key=?').get(key); return r && decodeDev(r); }
  deviceById(id) { const r = this.prep('SELECT * FROM devices WHERE id=?').get(id); return r && decodeDev(r); }
  devices() { return this.prep('SELECT * FROM devices ORDER BY name').all().map(decodeDev); }
  setDeviceStatus(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE devices SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => fields[c]), id);
  }

  // ---- points ----
  upsertPoint(deviceId, p, defaults) {
    const now = Date.now();
    const old = this.prep('SELECT * FROM points WHERE key=?').get(p.key);
    const states = p.states ? JSON.stringify(p.states) : null;
    if (!old) {
      this.prep(`INSERT INTO points(key,device_id,name,description,units,kind,states,cov,selected,interval_s,updated_at,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.key, deviceId, p.name, p.description || '', p.units ?? null, p.kind,
        states, p.cov ? 1 : 0, defaults.selected ? 1 : 0, defaults.interval_s, now, now);
      return 'created';
    }
    const changed = old.name !== p.name || old.description !== (p.description || '') || old.units !== (p.units ?? null) ||
      old.kind !== p.kind || old.states !== states || old.missing;
    if (changed) {
      this.prep(`UPDATE points SET name=?,description=?,units=?,kind=?,states=?,cov=?,missing=0,updated_at=? WHERE key=?`)
        .run(p.name, p.description || '', p.units ?? null, p.kind, states, p.cov ? 1 : 0, now, p.key);
      return 'changed';
    }
    return 'same';
  }
  setPointError(id, err) { this.prep('UPDATE points SET last_error=? WHERE id=?').run(err, id); }
  markMissing(deviceId, keepKeys) {
    const keep = new Set(keepKeys);
    let n = 0;
    for (const r of this.prep('SELECT id,key,missing FROM points WHERE device_id=?').all(deviceId)) {
      if (!keep.has(r.key) && !r.missing) { this.prep('UPDATE points SET missing=1,updated_at=? WHERE id=?').run(Date.now(), r.id); n++; }
    }
    return n;
  }
  points(deviceId) {
    const sql = deviceId ? 'SELECT * FROM points WHERE device_id=? ORDER BY name' : 'SELECT * FROM points ORDER BY device_id,name';
    return (deviceId ? this.prep(sql).all(deviceId) : this.prep(sql).all()).map(decodePoint);
  }
  activePoints() { return this.prep('SELECT * FROM points WHERE selected=1 AND missing=0').all().map(decodePoint); }
  updatePoints(changes) {
    const now = Date.now();
    this.tx(() => {
      for (const c of changes) {
        const sets = []; const args = [];
        if (c.selected !== undefined) { sets.push('selected=?'); args.push(c.selected ? 1 : 0); }
        if (c.interval_s !== undefined) { sets.push('interval_s=?'); args.push(Math.max(10, c.interval_s | 0)); }
        if (!sets.length) continue;
        sets.push('updated_at=?'); args.push(now);
        this.db.prepare(`UPDATE points SET ${sets.join(',')} WHERE key=?`).run(...args, c.key);
      }
    });
  }

  // ---- samples ----
  addSamples(rows) { // rows: [{p, t, v}]
    if (!rows.length) return;
    this.tx(() => {
      const ins = this.prep('INSERT INTO samples(p,t,v) VALUES(?,?,?)');
      const upd = this.prep('UPDATE points SET last_t=?,last_v=?,last_error=NULL WHERE id=?');
      for (const r of rows) { ins.run(r.p, r.t, r.v); upd.run(r.t, r.v, r.p); }
    });
  }
  recent(pointId, n = 20) { return this.prep('SELECT t,v FROM samples WHERE p=? ORDER BY id DESC LIMIT ?').all(pointId, n); }
  counts() {
    return {
      devices: this.prep('SELECT count(*) n FROM devices').get().n,
      offline: this.prep("SELECT count(*) n FROM devices WHERE status='offline'").get().n,
      error: this.prep("SELECT count(*) n FROM devices WHERE status='error'").get().n,
      duplicates: this.prep("SELECT count(*) n FROM devices WHERE meta LIKE '%duplicate_id%'").get().n,
      point_errors: this.prep('SELECT count(*) n FROM points WHERE last_error IS NOT NULL AND selected=1 AND missing=0').get().n,
      points: this.prep('SELECT count(*) n FROM points WHERE missing=0').get().n,
      selected: this.prep('SELECT count(*) n FROM points WHERE selected=1 AND missing=0').get().n,
      samples: this.prep('SELECT count(*) n FROM samples').get().n,
      max_id: this.prep('SELECT coalesce(max(id),0) n FROM samples').get().n,
    };
  }
  latePoints(now = Date.now()) {
    return this.prep(`SELECT count(*) n FROM points p JOIN devices d ON d.id=p.device_id
      WHERE p.selected=1 AND p.missing=0 AND p.cov_active=0 AND (p.last_t IS NULL OR p.last_t < ? - 2*p.interval_s*1000)
      AND d.first_seen < ? - 2*p.interval_s*1000`).get(now, now).n;
  }

  // ---- destinations ----
  destState(name) {
    let r = this.prep('SELECT * FROM dest_state WHERE name=?').get(name);
    if (!r) { this.prep('INSERT INTO dest_state(name) VALUES(?)').run(name); r = this.prep('SELECT * FROM dest_state WHERE name=?').get(name); }
    r.pending = r.pending ? JSON.parse(r.pending) : null;
    return r;
  }
  setDestState(name, f) {
    if ('pending' in f) f = { ...f, pending: f.pending ? JSON.stringify(f.pending) : null };
    const cols = Object.keys(f);
    this.db.prepare(`UPDATE dest_state SET ${cols.map(c => c + '=?').join(',')} WHERE name=?`).run(...cols.map(c => f[c]), name);
  }
  samplesAfter(id, limit) {
    return this.prep(`SELECT s.id, p.key, s.t, s.v FROM samples s JOIN points p ON p.id=s.p WHERE s.id>? ORDER BY s.id LIMIT ?`).all(id, limit);
  }
  samplesRange(fromId, toId) {
    return this.prep(`SELECT s.id, p.key, s.t, s.v FROM samples s JOIN points p ON p.id=s.p WHERE s.id>? AND s.id<=? ORDER BY s.id`).all(fromId, toId);
  }
  changedDevices(since) { return this.prep('SELECT * FROM devices WHERE updated_at>?').all(since).map(decodeDev); }
  changedPoints(since) { return this.prep('SELECT * FROM points WHERE updated_at>?').all(since).map(decodePoint); }
  oldestAfter(id) { const r = this.prep('SELECT min(t) t FROM samples WHERE id>?').get(id); return r ? r.t : null; }
  prune(uptoId, keepDays) {
    const cutoff = Date.now() - keepDays * 86400000;
    return Number(this.prep('DELETE FROM samples WHERE id<=? AND t<?').run(uptoId, cutoff).changes);
  }
  dropOldest(n) { return Number(this.prep('DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY id LIMIT ?)').run(n).changes); }
  sizeMb() {
    let s = 0;
    for (const f of [this.file, this.file + '-wal']) { try { s += fs.statSync(f).size; } catch { /* none */ } }
    return s / 1048576;
  }
  close() { this.db.close(); }
}

function decodeDev(r) { return { ...r, meta: r.meta ? JSON.parse(r.meta) : {} }; }
function decodePoint(r) { return { ...r, states: r.states ? JSON.parse(r.states) : null }; }

module.exports = { Store };
