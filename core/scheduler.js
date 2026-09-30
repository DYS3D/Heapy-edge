'use strict';
// Poll scheduler. Reads each selected point on its interval, lined up on the
// clock (e.g. :00 :15 :30 :45 for 15 minutes) with a small per-device offset so
// devices are not all asked in the same second.
// Safety rules: one request stream per device, one per routed trunk
// (e.g. an MS/TP network behind a router), a cap on parallel reads for the
// whole box, and a per-device request rate set by the driver settings.

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function laneOf(dev) {
  // BACnet routed devices look like "2001:5" (network:MAC): share one lane per network.
  const r = String(dev.route || '');
  const m = /^(\d+):(\S+)$/.exec(r);
  if (m && !r.includes('.')) return `${dev.driver}:net${m[1]}`;
  return `${dev.driver}:${dev.key}`;
}

class Scheduler {
  constructor({ store, drivers, settings, log }) {
    Object.assign(this, { store, drivers, settings, log });
    this.index = null;      // deviceId -> { dev, points: [..] }
    this.due = new Map();   // pointId -> next due ms
    this.busyLanes = new Set();
    this.busyDevices = new Set();
    this.active = 0;
    this.stats = { reads: 0, read_errors: 0, samples: 0, cov_samples: 0, last_read: null, missed_slots: 0 };
    this.keyToId = new Map();
    this.covTried = new Map();
    this.dirty = true;
    this.timer = null;
  }

  invalidate() { this.dirty = true; }

  rebuild() {
    const idx = new Map();
    const devs = new Map(this.store.devices().map(d => [d.id, d]));
    this.keyToId.clear();
    for (const p of this.store.activePoints()) {
      const d = devs.get(p.device_id);
      if (!d) continue;
      this.keyToId.set(p.key, p.id);
      if (!idx.has(d.id)) idx.set(d.id, { dev: d, points: [] });
      idx.get(d.id).points.push(p);
    }
    const now = Date.now();
    const keep = new Set();
    for (const { dev, points } of idx.values()) {
      for (const p of points) {
        keep.add(p.id);
        if (!this.due.has(p.id)) this.due.set(p.id, this.firstDue(dev, p, now));
      }
    }
    for (const id of this.due.keys()) if (!keep.has(id)) this.due.delete(id);
    this.index = idx;
    this.dirty = false;
    this.builtAt = Date.now();
  }

  offset(dev, intervalMs) { return hash(dev.key) % Math.min(intervalMs, 30000); }
  slot(t, iv, off) { return Math.floor((t - off) / iv) * iv + off; }
  interval(p) {
    const s = this.settings().poll;
    const iv = Math.max(10, p.interval_s || s.default_interval_s || 900) * 1000;
    return p.cov_active ? Math.max(iv, (s.cov_heartbeat_s || 3600) * 1000) : iv;
  }
  firstDue(dev, p, now) {
    const iv = this.interval(p), off = this.offset(dev, iv);
    if (!p.last_t) return now + (hash(p.key) % 5000); // never read: read soon, spread over 5 s
    const next = this.slot(p.last_t, iv, off) + iv;
    return next <= now ? now + (hash(p.key) % 5000) : next;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 500);
  }
  async stop() {
    clearInterval(this.timer);
    this.stopped = true;
    const end = Date.now() + 30000; // let reads in progress finish before the buffer closes
    while (this.active > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  }

  tick() {
    if (this.stopped) return;
    if (this.dirty || !this.index || Date.now() - (this.builtAt || 0) > 60000) this.rebuild();
    const s = this.settings();
    const maxPar = s.poll.max_parallel || 8;
    const now = Date.now();
    // most overdue device first, so no device on a busy trunk is starved
    const cands = [];
    for (const [devId, entry] of this.index) {
      let min = Infinity;
      for (const p of entry.points) { const d = this.due.get(p.id) || 0; if (d < min) min = d; }
      if (min <= now) cands.push([min, devId, entry]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [, devId, entry] of cands) {
      if (this.active >= maxPar) break;
      const { dev } = entry;
      const host = this.drivers[dev.driver];
      if (!host || !host.ready) continue;
      const lane = laneOf(dev);
      if (this.busyDevices.has(devId) || this.busyLanes.has(lane)) continue;
      const cur = this.store.deviceById(devId);
      if (!cur) continue;
      if (cur.status === 'offline' && cur.retry_at > now) continue;
      const duePts = entry.points.filter(p => (this.due.get(p.id) || 0) <= now);
      if (!duePts.length) continue;
      const max = s.poll.max_points_per_read || 200;
      const batch = duePts.slice(0, max);
      this.busyDevices.add(devId); this.busyLanes.add(lane); this.active++;
      this.readBatch(host, cur, batch).finally(() => {
        this.busyDevices.delete(devId); this.busyLanes.delete(lane); this.active--;
        setImmediate(() => this.tick()); // a free lane is used straight away
      });
    }
  }

  async readBatch(host, dev, batch) {
    const s = this.settings();
    const dcfg = s.drivers[dev.driver] || {};
    const started = Date.now();
    try {
      const res = await host.call('read', { device: dev, points: batch.map(p => p.key), rate: dcfg.rate_per_device || 5 },
        { timeoutMs: 30000 + batch.length * 1000 });
      const byKey = new Map(batch.map(p => [p.key, p]));
      const rows = [];
      let errs = 0;
      for (const v of res.values) {
        const p = byKey.get(v.point);
        if (!p) continue;
        if (v.v === null || v.v === undefined) { errs++; continue; }
        rows.push({ p: p.id, t: v.t, v: v.v });
      }
      this.store.addSamples(rows);
      this.stats.reads++; this.stats.samples += rows.length; this.stats.last_read = Date.now();
      const fields = { status: 'online', fails: 0, retry_at: 0 };
      if (dev.status !== 'online' || dev.last_error) fields.last_error = null;
      this.store.setDeviceStatus(dev.id, fields);
      if (dev.status === 'offline') this.log('info', `${dev.name} is answering again`);
      if (errs) this.store.setDeviceStatus(dev.id, { last_error: `${errs} point(s) returned no value` });
    } catch (e) {
      this.stats.read_errors++;
      const fails = (dev.fails || 0) + 1;
      const offAfter = s.poll.offline_after || 3;
      const fields = { fails, last_error: `${e.code || 'error'}: ${e.message}` };
      if (fails >= offAfter) {
        fields.status = 'offline';
        fields.retry_at = Date.now() + (s.poll.offline_retry_s || 300) * 1000;
        if (dev.status !== 'offline') this.log('warn', `${dev.name} is not answering (${e.code || e.message}); retrying every ${s.poll.offline_retry_s || 300}s`);
      }
      this.store.setDeviceStatus(dev.id, fields);
    } finally {
      // next slot for each point in the batch; missed slots are skipped, never bunched up
      const now = Date.now();
      for (const p of batch) {
        const iv = this.interval(p), off = this.offset(dev, iv);
        let next = this.slot(started, iv, off) + iv;
        if (next <= now) { this.stats.missed_slots++; next = this.slot(now, iv, off) + iv; }
        this.due.set(p.id, next);
      }
    }
  }

  // ---- change of value (optional, poll.use_cov) ----
  async covTick() {
    const s = this.settings();
    if (!s.poll.use_cov || !this.index) return;
    for (const [devId, { dev, points }] of this.index) {
      const host = this.drivers[dev.driver];
      if (!host || !host.ready || !host.info?.capabilities?.includes('subscribe')) continue;
      const want = points.filter(p => p.cov && !p.cov_active);
      if (!want.length) continue;
      const last = this.covTried.get(devId) || 0;
      if (Date.now() - last < 3600000) continue;
      this.covTried.set(devId, Date.now());
      try {
        const r = await host.call('subscribe', { device: dev, points: want.map(p => p.key), lifetime_s: s.poll.cov_lifetime_s || 900 }, { timeoutMs: 15000 * want.length });
        for (const k of r.subscribed) this.store.db.prepare('UPDATE points SET cov_active=1 WHERE key=?').run(k);
        if (r.subscribed.length) this.log('info', `${dev.name}: change-of-value on ${r.subscribed.length} points`);
        this.invalidate();
      } catch (e) { this.log('info', `${dev.name}: no change-of-value (${e.code || e.message})`); }
    }
  }
  onCov(data) {
    const id = this.keyToId.get(data.point);
    if (!id || data.v === null || data.v === undefined) return;
    this.store.addSamples([{ p: id, t: data.t, v: data.v }]);
    this.stats.cov_samples++;
  }
  resetCov(driver) {
    this.store.db.prepare(`UPDATE points SET cov_active=0 WHERE cov_active=1 AND device_id IN (SELECT id FROM devices WHERE driver=?)`).run(driver);
    this.covTried.clear();
    this.invalidate();
  }
}

module.exports = { Scheduler, laneOf };
