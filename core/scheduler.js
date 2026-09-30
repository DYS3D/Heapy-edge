'use strict';
// Poll scheduler. Reads each selected point on its interval, lined up on the
// clock (e.g. :00 :15 :30 :45 for 15 minutes) with a small per-device offset so
// devices are not all asked in the same second.
// Safety rules: one request stream per device, one per routed trunk
// (e.g. an MS/TP network behind a router), a cap on parallel reads for the
// whole box, and a per-device request rate set by the driver settings.

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function laneOf(dev) {
  // a driver can say which shared path a device sits on (e.g. a Modbus gateway or serial port)
  if (dev.meta && dev.meta.lane) return `${dev.driver}:net:${dev.meta.lane}`;
  // BACnet routed devices look like "2001:5" (network:MAC): share one lane per network.
  const r = String(dev.route || '');
  const m = /^(\d+):(\S+)$/.exec(r);
  if (m && !r.includes('.')) return `${dev.driver}:net${m[1]}`;
  return `${dev.driver}:${dev.key}`;
}

const { performance } = require('node:perf_hooks');

class Scheduler {
  constructor({ store, drivers, settings, log, onDeviceChanged = () => {}, onStoreError = () => {} }) {
    Object.assign(this, { store, drivers, settings, log, onDeviceChanged, onStoreError });
    this.index = null;      // deviceId -> { dev, points: [..] }
    this.due = new Map();   // pointId -> next due ms
    this.busyLanes = new Map(); // lane -> reads in progress
    this.busyDevices = new Set();
    this.active = 0;
    this.stats = { reads: 0, read_errors: 0, samples: 0, cov_samples: 0, last_read: null, missed_slots: 0,
      point_errors: 0, bad_values: 0, clock_jumps: 0, relocated: 0, store_errors: 0 };
    this.pointErr = new Map(); // pointId -> consecutive "gone" errors
    this.laneLate = new Map(); // lane -> { t, n } readings skipped because the lane was behind
    this.retried = new Map();  // pointId -> last immediate retry
    this.clockRef = null;
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
    // change-of-value only adds readings; polling never stops, so a lost
    // subscription (e.g. a controller reboot) can't leave a gap
    const s = this.settings().poll;
    return Math.max(10, p.interval_s || s.default_interval_s || 900) * 1000;
  }

  // The wall clock can jump (NTP fix, manual change, dead RTC battery on a Pi).
  // Compare it with the monotonic clock; on a jump, line every point up again.
  checkClock() {
    const wall = Date.now(), mono = performance.now();
    if (this.clockRef) {
      const drift = (wall - this.clockRef.wall) - (mono - this.clockRef.mono);
      if (Math.abs(drift) > 5000) {
        this.stats.clock_jumps++;
        this.log('warn', `clock changed by ${Math.round(drift / 1000)} s; rescheduling all points`);
        for (const [id] of this.due) this.due.set(id, wall + (id % 5000));
        this.store.db.prepare("UPDATE devices SET retry_at=? WHERE status IN ('offline','error')").run(wall);
      }
    }
    this.clockRef = { wall, mono };
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
    this.checkClock();
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
      const cur = this.store.deviceById(devId);
      if (!cur) continue;
      // routed trunks (e.g. MS/TP behind a router) allow poll.per_trunk reads at once.
      // A device that is failing (waiting out timeouts) uses a separate probe slot,
      // so one dead controller can't hold up every other device on its trunk.
      let lane = laneOf(dev);
      const suspect = (cur.fails || 0) > 0 || cur.status === 'offline' || cur.status === 'error';
      if (suspect && lane.includes(':net')) lane += ':probe';
      const laneMax = lane.endsWith(':probe') ? 1 : lane.includes(':net') ? (dev.meta?.lane_max || s.poll.per_trunk || 2) : 1;
      if (this.busyDevices.has(devId) || (this.busyLanes.get(lane) || 0) >= laneMax) continue;
      if ((cur.status === 'offline' || cur.status === 'error') && cur.retry_at > now) continue;
      const duePts = entry.points.filter(p => (this.due.get(p.id) || 0) <= now);
      if (!duePts.length) continue;
      const max = s.poll.max_points_per_read || 200;
      const batch = duePts.slice(0, max);
      this.busyDevices.add(devId); this.busyLanes.set(lane, (this.busyLanes.get(lane) || 0) + 1); this.active++;
      this.readBatch(host, cur, batch).finally(() => {
        this.busyDevices.delete(devId); this.busyLanes.set(lane, this.busyLanes.get(lane) - 1); this.active--;
        setImmediate(() => this.tick()); // a free lane is used straight away
      });
    }
  }

  async readBatch(host, dev, batch) {
    const s = this.settings();
    const dcfg = s.drivers[dev.driver] || {};
    const started = Date.now();
    let res;
    try {
      res = await host.call('read', { device: dev, points: batch.map(p => p.key), rate: dcfg.rate_per_device || 5 },
        { timeoutMs: 30000 + batch.length * 1000 });
    } catch (e) {
      await this.readFailed(host, dev, e);
      this.reschedule(dev, batch, started);
      // first failure: try once more straight away (a single lost reply
      // shouldn't cost a whole interval of readings)
      if ((dev.fails || 0) === 0) this.retrySoon(batch);
      return;
    }
    let again = [];
    try {
      again = this.readDone(dev, batch, res);
    } catch (e) {
      // the buffer could not be written (e.g. disk full): not the device's fault
      this.stats.store_errors++;
      this.onStoreError(e);
    }
    this.reschedule(dev, batch, started);
    this.retrySoon(again);
  }

  // Read these points again in a second, once per slot.
  retrySoon(points) {
    const now = Date.now();
    for (const p of points) {
      const last = this.retried.get(p.id) || 0;
      if (now - last < this.interval(p) / 2) continue;
      this.retried.set(p.id, now);
      this.stats.retries = (this.stats.retries || 0) + 1;
      this.due.set(p.id, now + 1000);
    }
  }

  readDone(dev, batch, res) {
    const byKey = new Map(batch.map(p => [p.key, p]));
    const rows = [], errs = [], again = [];
    let gone = false;
    for (const v of res.values || []) {
      const p = byKey.get(v.point);
      if (!p) continue;
      if (typeof v.v === 'number' && Number.isFinite(v.v) && Number.isFinite(v.t)) {
        rows.push({ p: p.id, t: v.t, v: v.v });
        if (p.last_error) this.store.setPointError(p.id, null);
        this.pointErr.delete(p.id);
        continue;
      }
      if (v.v !== null && v.v !== undefined) this.stats.bad_values++;
      this.stats.point_errors++;
      const err = v.error || 'no value';
      errs.push(err);
      // lost reply, or an error the driver says is passing: read again shortly, not a point problem
      if (err === 'no answer' || v.retry === true) { again.push(p); if (err === 'no answer') continue; }
      if (p.last_error !== err) this.store.setPointError(p.id, err);
      if (/unknown-object|unknown-property/.test(err)) {
        const n = (this.pointErr.get(p.id) || 0) + 1;
        this.pointErr.set(p.id, n);
        if (n === 3) gone = true;
      }
    }
    this.store.addSamples(rows);
    this.stats.reads++; this.stats.samples += rows.length; this.stats.last_read = Date.now();
    const fields = { status: 'online', fails: 0, retry_at: 0 };
    const lastErr = errs.length ? `${errs.length} point(s): ${errs[0]}` : null;
    if (dev.last_error !== lastErr) fields.last_error = lastErr;
    if (dev.status === 'offline' || dev.status === 'error') this.log('info', `${dev.name} is answering again`);
    this.store.setDeviceStatus(dev.id, fields);
    // points that no longer exist on the device: list its points again
    if (gone) this.onDeviceChanged(dev, 'points missing on the device');
    return again;
  }

  async readFailed(host, dev, e) {
    const s = this.settings();
    this.stats.read_errors++;
    const fails = (dev.fails || 0) + 1;
    const offAfter = s.poll.offline_after || 3;
    const fields = { fails, last_error: `${e.code || 'error'}: ${e.message}` };
    if (fails >= offAfter) {
      // answering with errors = 'error'; not answering at all = 'offline'
      fields.status = e.code === 'rejected' ? 'error' : 'offline';
      fields.retry_at = Date.now() + (s.poll.offline_retry_s || 300) * 1000;
      if (dev.status !== fields.status) {
        this.log('warn', `${dev.name} ${fields.status === 'error' ? 'refuses reads' : 'is not answering'} (${e.message}); retrying every ${s.poll.offline_retry_s || 300}s`);
      }
      // a device that moved (new IP, new router) answers a Who-Is at its new address
      if (fields.status === 'offline' && host.info?.capabilities?.includes('locate')) {
        try {
          const r = await host.call('locate', { device: dev, timeout_s: 3 }, { timeoutMs: 20000 });
          if (r.route && r.route !== dev.route) {
            this.store.setDeviceStatus(dev.id, { route: r.route, updated_at: Date.now() });
            this.stats.relocated++;
            fields.retry_at = Date.now();
            this.log('info', `${dev.name} moved from ${dev.route} to ${r.route}`);
            this.invalidate();
          }
        } catch { /* try again at the next retry */ }
      }
    }
    this.store.setDeviceStatus(dev.id, fields);
  }

  reschedule(dev, batch, started) {
    // Next slot for each point. A read that ran a little late (lost packet, slow
    // reply) is followed straight away so no reading is lost; if it ran more
    // than half an interval late the slot is skipped instead of bunching reads up.
    const now = Date.now();
    for (const p of batch) {
      const iv = this.interval(p), off = this.offset(dev, iv);
      let next = this.slot(started, iv, off) + iv;
      if (next <= now && now - next < iv / 2) { this.due.set(p.id, now); this.stats.late_reads = (this.stats.late_reads || 0) + 1; continue; }
      if (next <= now) {
        this.stats.missed_slots++;
        next = this.slot(now, iv, off) + iv;
        const lane = laneOf(dev);
        this.laneLate.set(lane, { t: now, n: ((this.laneLate.get(lane) || {}).n || 0) + 1 });
      }
      this.due.set(p.id, next);
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
    if (!id || typeof data.v !== 'number' || !Number.isFinite(data.v)) return;
    try { this.store.addSamples([{ p: id, t: data.t, v: data.v }]); this.stats.cov_samples++; } catch (e) { this.stats.store_errors++; this.onStoreError(e); }
  }
  // Lanes (devices or trunks) that could not keep up in the last hour: the
  // interval is too short for what that trunk can carry.
  lanesBehind() {
    const out = [];
    for (const [lane, v] of this.laneLate) if (Date.now() - v.t < 3600000) out.push({ lane, skipped: v.n });
    return out;
  }

  // A device announced itself (restart, back on the network): if it was offline,
  // try it now instead of waiting for the retry timer; follow a new address.
  onAnnounce(driver, d) {
    const dev = this.store.device(d.key);
    if (!dev || dev.driver !== driver) return;
    const fields = {};
    const down = dev.status === 'offline' || dev.status === 'error';
    if (dev.route !== d.route) {
      if (down && !(dev.meta && dev.meta.duplicate_id)) {
        // the device went quiet at its old address and now speaks from a new one: it moved
        fields.route = d.route; fields.updated_at = Date.now();
        this.stats.relocated++;
        this.log('info', `${dev.name} now answers at ${d.route} (was ${dev.route})`);
        this.invalidate();
      } else if (!(dev.meta && dev.meta.duplicate_id)) {
        // still answering at its own address: a second device is using the same number
        fields.meta = JSON.stringify({ ...dev.meta, duplicate_id: [dev.route, d.route] });
        fields.updated_at = Date.now();
        this.log('warn', `two devices use device number ${d.instance}: ${dev.route} and ${d.route}; the next scan lists both`);
      }
    }
    if (dev.status === 'offline' || dev.status === 'error') fields.retry_at = Date.now();
    if (Object.keys(fields).length) this.store.setDeviceStatus(dev.id, fields);
  }

  resetCov(driver) {
    this.store.db.prepare(`UPDATE points SET cov_active=0 WHERE cov_active=1 AND device_id IN (SELECT id FROM devices WHERE driver=?)`).run(driver);
    this.covTried.clear();
    this.invalidate();
  }
}

module.exports = { Scheduler, laneOf };
