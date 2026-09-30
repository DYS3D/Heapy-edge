'use strict';
// Stand-in for the Trend Tracker intake API (contracts/upload-api.json), used by
// the self-test until Phase 2 builds the real one. Can be told to fail.
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function startMockIntake({ port = 0 } = {}) {
  const st = {
    codes: new Set(['TEST-0001']), boxes: new Map(), batches: new Map(), samples: [], seen: new Set(), dupSamples: 0,
    devices: new Map(), points: new Map(), checkins: 0, failUntil: 0, failCode: 500, requests: 0, config: null, configVersion: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      st.requests++;
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      const body = buf.length ? JSON.parse(buf) : {};
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/stats' || req.url === '/fail') { /* test control, no key */ }
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const box = auth ? st.boxes.get(auth[1]) : null;
      if (req.url === '/stats') return send(200, { seen: st.seen.size, dup: st.dupSamples, batches: st.batches.size });
      if (req.url === '/fail' && req.method === 'POST') { st.failUntil = Date.now() + (body.ms || 120000); return send(200, { ok: true }); }
      if (req.url === '/api/edge/v1/pair') {
        if (!st.codes.has(body.code)) return send(403, { error: 'bad code' });
        st.codes.delete(body.code);
        const key = crypto.randomBytes(24).toString('hex'), id = 'box-' + (st.boxes.size + 1);
        st.boxes.set(key, { id, info: body.box });
        return send(200, { box_id: id, key, site: 'Simulated site' });
      }
      if (!box) return send(401, { error: 'no key' });
      if (req.url === '/api/edge/v1/ingest') {
        if (Date.now() < st.failUntil) return send(st.failCode, { error: 'test failure' });
        if (st.batches.has(body.batch_id)) return send(200, { ok: true, batch_id: body.batch_id, stored: 0, duplicate: true });
        st.batches.set(body.batch_id, { seq: body.seq, n: body.samples.length });
        for (const d of body.devices || []) st.devices.set(d.key, d);
        for (const p of body.points || []) st.points.set(p.key, p);
        for (const s of body.samples) {
          const k = s[0] + '@' + s[1];
          if (st.seen.has(k)) st.dupSamples++; else st.seen.add(k);
          st.samples.push(s);
        }
        return send(200, { ok: true, batch_id: body.batch_id, stored: body.samples.length });
      }
      if (req.url === '/api/edge/v1/checkin') {
        st.checkins++; st.lastHealth = body.health;
        const out = { config_version: st.configVersion };
        if (st.config && (body.config_version || 0) < st.configVersion) out.config = st.config;
        return send(200, out);
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(c => server.close(c)) })));
}

module.exports = { startMockIntake };

if (require.main === module) {
  // node tests/mock-intake.js 8790  -> stand-alone stand-in server (pairing code TEST-0001)
  startMockIntake({ port: Number(process.argv[2] || 8790) }).then(m => {
    m.st.boxes.set(process.argv[3] || 'k', { id: 'box-soak' });
    console.log(`mock intake on ${m.url}`);
    setInterval(() => { m.st.samples.length = 0; }, 60000); // keep only counts in long runs
  });
}
