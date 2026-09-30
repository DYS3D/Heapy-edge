'use strict';
// Sends buffered readings to each destination (contracts/upload-api.json).
// A batch is only cleared after the destination confirms it; a failed batch is
// resent with the same batch_id so the server can ignore duplicates.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEST_TYPES = {
  // Central HEAPY Trend Tracker server over HTTPS (outbound only).
  https: {
    async send(dest, batch, ctx) {
      const secret = ctx.secret();
      if (!dest.url) throw Object.assign(new Error('no server address'), { permanent: true });
      if (!secret.key) throw Object.assign(new Error('box is not paired'), { permanent: true });
      const body = zlib.gzipSync(Buffer.from(JSON.stringify(batch)));
      const res = await fetch(new URL('/api/edge/v1/ingest', dest.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${secret.key}` },
        body, signal: AbortSignal.timeout(60000),
      });
      const txt = await res.text();
      if (!res.ok) {
        const e = new Error(`server said ${res.status}: ${txt.slice(0, 200)}`);
        e.status = res.status;
        e.permanent = res.status >= 400 && res.status < 500 && ![408, 413, 429].includes(res.status);
        throw e;
      }
      let j;
      try { j = JSON.parse(txt); } catch { throw new Error('server reply was not readable'); }
      if (!j || !j.ok || j.batch_id !== batch.batch_id) throw new Error('server did not confirm the batch');
      return j;
    },
  },
  // Writes batches as .json.gz files (USB stick, shared folder, or testing).
  file: {
    async send(dest, batch) {
      fs.mkdirSync(dest.dir, { recursive: true });
      const f = path.join(dest.dir, `batch-${String(batch.seq).padStart(8, '0')}-${batch.batch_id}.json.gz`);
      fs.writeFileSync(f + '.part', zlib.gzipSync(Buffer.from(JSON.stringify(batch))));
      fs.renameSync(f + '.part', f);
      return { ok: true, batch_id: batch.batch_id, stored: batch.samples.length };
    },
  },
  // Full on-site mode (Phase 8): a Trend Tracker on this box uses the same
  // ingest API on localhost, so it is an https destination with a local url.
};

class Uploader {
  constructor({ store, settings, secret, log, boxInfo }) {
    Object.assign(this, { store, settings, secret, log, boxInfo });
    this.busy = false;
    this.lastRun = 0;
  }

  enabled() { return (this.settings().destinations || []).filter(d => d.enabled); }

  async tick(force = false) {
    if (this.busy) return;
    const s = this.settings();
    if (!force && Date.now() - this.lastRun < (s.upload.every_s || 300) * 1000) return;
    this.busy = true; this.lastRun = Date.now();
    try {
      for (const d of this.enabled()) await this.drain(d);
      this.prune();
    } finally { this.busy = false; }
  }

  async drain(dest) {
    const type = DEST_TYPES[dest.type];
    if (!type) { this.log('error', `unknown destination type ${dest.type}`); return; }
    const s = this.settings();
    this.maxBatch = this.maxBatch || {};
    const maxFor = () => this.maxBatch[dest.name] || s.upload.batch_max || 20000;
    for (let round = 0; round < 50; round++) {
      const st = this.store.destState(dest.name);
      if (st.next_try > Date.now()) return;
      let pending = st.pending;
      if (!pending) {
        const rows = this.store.samplesAfter(st.last_id, maxFor());
        const devs = this.store.changedDevices(st.meta_t);
        const pts = this.store.changedPoints(st.meta_t);
        if (!rows.length && !devs.length && !pts.length) return;
        pending = {
          batch_id: crypto.randomUUID(), seq: st.seq + 1, from: st.last_id,
          to: rows.length ? rows[rows.length - 1].id : st.last_id, meta_t: Date.now(),
        };
        this.store.setDestState(dest.name, { pending });
      }
      const rows = this.store.samplesRange(pending.from, pending.to);
      const batch = {
        batch_id: pending.batch_id, box_id: this.secret().box_id || null, seq: pending.seq, sent_at: Date.now(),
        devices: this.store.changedDevices(st.meta_t).map(d => ({ key: d.key, route: d.route, name: d.name, vendor: d.vendor, model: d.model, meta: d.meta, status: d.status })),
        points: this.store.changedPoints(st.meta_t).map(p => ({
          key: p.key, device: this.store.deviceById(p.device_id)?.key, name: p.name, description: p.description, units: p.units,
          kind: p.kind, states: p.states, selected: !!p.selected, interval_s: p.interval_s, missing: !!p.missing,
        })),
        samples: rows.map(r => [r.key, r.t, r.v]),
      };
      try {
        await type.send(dest, batch, { secret: this.secret, boxInfo: this.boxInfo });
        this.store.setDestState(dest.name, { last_id: pending.to, seq: pending.seq, meta_t: pending.meta_t, pending: null, last_ok: Date.now(), last_error: null, fails: 0, next_try: 0 });
        if (st.fails) this.log('info', `${dest.name}: sending again after ${st.fails} failed tries`);
        if (rows.length < maxFor()) return;
      } catch (e) {
        if (e.status === 413 && pending.to - pending.from > 100) {
          // the server wants smaller batches: split this one and try again now
          this.maxBatch[dest.name] = Math.max(100, Math.floor(rows.length / 2));
          this.store.setDestState(dest.name, { pending: null });
          this.log('warn', `${dest.name}: batch too large, sending ${this.maxBatch[dest.name]} readings at a time`);
          continue;
        }
        const fails = st.fails + 1;
        const wait = e.permanent ? (s.upload.permanent_retry_s || 900) * 1000 : Math.min((s.upload.max_retry_s || 300) * 1000, 5000 * 2 ** Math.min(fails, 9));
        this.store.setDestState(dest.name, { last_error: e.message, fails, next_try: Date.now() + wait });
        if (fails === 1 || fails % 10 === 0) this.log('warn', `${dest.name}: could not send (${e.message}); next try in ${Math.round(wait / 1000)}s`);
        return;
      }
    }
  }

  prune() {
    const s = this.settings();
    const dests = this.enabled();
    const c = this.store.counts();
    let upto = c.max_id;
    for (const d of dests) upto = Math.min(upto, this.store.destState(d.name).last_id);
    if (dests.length) this.store.prune(upto, s.buffer.keep_days ?? 30);
    else this.store.prune(c.max_id, s.buffer.keep_days_unsent ?? 365);
    // disk guard: never let the buffer fill the disk
    const maxMb = s.buffer.max_mb || 20000;
    if (this.store.sizeMb() > maxMb) {
      const n = this.store.dropOldest(100000);
      this.log('error', `buffer over ${maxMb} MB: dropped the ${n} oldest readings`);
    }
  }

  // Disk full: drop readings every enabled destination already has, oldest first.
  emergencyPrune() {
    const dests = this.enabled();
    if (!dests.length) return 0;
    let upto = Infinity;
    for (const d of dests) upto = Math.min(upto, this.store.destState(d.name).last_id);
    const n = this.store.prune(upto, 0);
    try { this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    return n;
  }

  health() {
    const out = {};
    for (const d of this.settings().destinations || []) {
      const st = this.store.destState(d.name);
      out[d.name] = {
        type: d.type, enabled: !!d.enabled, url: d.url || d.dir || null, last_ok: st.last_ok, last_error: st.last_error,
        fails: st.fails, backlog: this.store.counts().max_id - st.last_id, oldest_unsent: this.store.oldestAfter(st.last_id), seq: st.seq,
      };
    }
    return out;
  }
}

module.exports = { Uploader, DEST_TYPES };
