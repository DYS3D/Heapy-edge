'use strict';
// Stand-in for the Trend Tracker intake API (contracts/upload-api.json), used by
// the tests until Phase 2 builds the real one. It can be told to misbehave.
//   POST /mode {"mode": "ok|500|429|401|hang|garbage|wrong_id|413", "ms": 60000, "max_samples": 500}
//   GET  /stats  -> counts;  GET /seen -> every point@time received (for loss checks)
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function startMockIntake({ port = 0, persist = null } = {}) {
  const st = {
    codes: new Set(['TEST-0001']), boxes: new Map(), batches: new Map(), samples: [], seen: new Set(), dupSamples: 0,
    devices: new Map(), points: new Map(), checkins: 0, failUntil: 0, failCode: 500, requests: 0, config: null, configVersion: 0,
    mode: 'ok', modeUntil: 0, maxSamples: 0, rejected: 0, keepSamples: true,
  };
  // --persist: keep what was received in a file, so a long test survives a restart
  let persistFd = null;
  if (persist) {
    const fs = require('node:fs');
    if (fs.existsSync(persist)) {
      for (const line of fs.readFileSync(persist, 'utf8').split('\n')) {
        if (!line) continue;
        const [kind, v] = [line[0], line.slice(2)];
        if (kind === 'B') st.batches.set(v, {});
        else if (kind === 'S') { if (st.seen.has(v)) st.dupSamples++; else st.seen.add(v); }
      }
    }
    persistFd = fs.openSync(persist, 'a');
    st.persist = lines => fs.writeSync(persistFd, lines.join('\n') + '\n');
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      st.requests++;
      const send = (code, obj, raw) => {
        if (res.writableEnded) return;
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(raw !== undefined ? raw : JSON.stringify(obj));
      };
      let body = {};
      try {
        let buf = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        body = buf.length ? JSON.parse(buf) : {};
      } catch { return send(400, { error: 'bad body' }); }

      // ---- test control (no key) ----
      if (req.url === '/stats') return send(200, { seen: st.seen.size, dup: st.dupSamples, batches: st.batches.size, requests: st.requests, rejected: st.rejected, checkins: st.checkins, mode: st.mode });
      if (req.url.startsWith('/seen')) {
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
        return send(200, since ? [...st.seen].filter(k => Number(k.slice(k.lastIndexOf('@') + 1)) >= since) : [...st.seen]);
      }
      if (req.url === '/mode' && req.method === 'POST') {
        st.mode = body.mode || 'ok'; st.modeUntil = body.ms ? Date.now() + body.ms : 0; st.maxSamples = body.max_samples || 0;
        return send(200, { ok: true });
      }
      if (req.url === '/fail' && req.method === 'POST') { st.mode = '500'; st.modeUntil = Date.now() + (body.ms || 120000); return send(200, { ok: true }); }
      if (req.url === '/codes' && req.method === 'POST') { st.codes.add(body.code); return send(200, { ok: true }); }

      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const box = auth ? st.boxes.get(auth[1]) : null;
      if (req.url === '/api/edge/v1/pair') {
        if (!st.codes.has(body.code)) return send(403, { error: 'bad code' });
        st.codes.delete(body.code);
        const key = crypto.randomBytes(24).toString('hex'), id = 'box-' + (st.boxes.size + 1);
        st.boxes.set(key, { id, info: body.box });
        return send(200, { box_id: id, key, site: 'Simulated site' });
      }
      if (!box) return send(401, { error: 'no key' });

      if (req.url === '/api/edge/v1/ingest') {
        if (st.modeUntil && Date.now() > st.modeUntil) { st.mode = 'ok'; st.modeUntil = 0; }
        const m = st.mode;
        if (m !== 'ok') st.rejected++;
        if (m === '500') return send(500, { error: 'test failure' });
        if (m === '429') return send(429, { error: 'slow down' });
        if (m === '401') return send(401, { error: 'key revoked' });
        if (m === 'hang') return; // never answer; the box must time out
        if (m === 'garbage') return send(200, null, '<html>proxy error</html>');
        if (m === 'wrong_id') return send(200, { ok: true, batch_id: 'not-yours', stored: 0 });
        if (m === '413' && st.maxSamples && body.samples.length > st.maxSamples) return send(413, { error: 'too large' });
        if (st.batches.has(body.batch_id)) return send(200, { ok: true, batch_id: body.batch_id, stored: 0, duplicate: true });
        st.batches.set(body.batch_id, { seq: body.seq, n: body.samples.length });
        if (st.persist) st.persist([`B ${body.batch_id}`, ...body.samples.map(x => `S ${x[0]}@${x[1]}`)]);
        for (const d of body.devices || []) st.devices.set(d.key, d);
        for (const p of body.points || []) st.points.set(p.key, p);
        for (const s of body.samples) {
          const k = s[0] + '@' + s[1];
          if (st.seen.has(k)) st.dupSamples++; else st.seen.add(k);
          if (st.keepSamples) st.samples.push(s);
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
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(c => { server.closeAllConnections?.(); server.close(c); }) })));
}

module.exports = { startMockIntake };

if (require.main === module) {
  // node tests/mock-intake.js <port> [key]  -> stand-alone server; the key is accepted as a paired box
  const pi = process.argv.indexOf('--persist');
  startMockIntake({ port: Number(process.argv[2] || 8790), persist: pi > 0 ? process.argv[pi + 1] : null }).then(m => {
    m.st.boxes.set(process.argv[3] || 'k', { id: 'box-test' });
    m.st.keepSamples = false;
    console.log(`mock intake on ${m.url}`);
  });
}
