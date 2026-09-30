'use strict';
// Local setup page for the site box (BAS network side only). Password
// protected; the first visit sets the password.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(hashPw(pw, salt).split(':')[1], 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class Web {
  constructor(app) {
    this.app = app;
    this.sessions = new Map();
    this.fails = [];
  }

  start() {
    const s = this.app.config.get().web;
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => {
      this.app.log('error', `web: ${e.stack || e.message}`);
      if (!res.headersSent) this.json(res, 500, { error: 'Something went wrong on the box. See the log.' });
    }));
    return new Promise(r => this.server.listen(s.port, s.bind, () => { this.app.log('info', `setup page on port ${this.server.address().port}`); r(); }));
  }
  stop() { return new Promise(r => this.server ? this.server.close(() => r()) : r()); }
  port() { return this.server.address().port; }

  json(res, code, obj, extra = {}) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  }
  body(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > 1e6) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch (e) { reject(e); } });
    });
  }
  session(req) {
    const m = /(?:^|;\s*)edge_s=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s || s.exp < Date.now()) { this.sessions.delete(m[1]); return null; }
    s.exp = Date.now() + 8 * 3600000;
    return m[1];
  }
  newSession(res) {
    const tok = crypto.randomBytes(32).toString('hex');
    this.sessions.set(tok, { exp: Date.now() + 8 * 3600000 });
    return { 'set-cookie': `edge_s=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` };
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://box');
    const p = url.pathname;
    const app = this.app;
    if (!p.startsWith('/api/')) return this.static(p, res);
    if (req.method === 'POST' && req.headers['x-edge'] !== '1') return this.json(res, 403, { error: 'missing header' });
    const secret = app.config.secret();
    const authed = !!this.session(req);

    if (p === '/api/session') return this.json(res, 200, { authed, needs_password: !secret.admin_hash, name: app.config.get().name, version: app.version });
    if (p === '/api/setup-password' && req.method === 'POST') {
      if (secret.admin_hash) return this.json(res, 409, { error: 'A password is already set.' });
      const b = await this.body(req);
      if (!b.password || String(b.password).length < 10) return this.json(res, 400, { error: 'Use at least 10 characters.' });
      app.config.setSecret({ admin_hash: hashPw(String(b.password)) });
      app.log('info', 'setup page password set');
      return this.json(res, 200, { ok: true }, this.newSession(res));
    }
    if (p === '/api/login' && req.method === 'POST') {
      const now = Date.now();
      this.fails = this.fails.filter(t => t > now - 15 * 60000);
      if (this.fails.length >= 10) return this.json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      const b = await this.body(req);
      if (!checkPw(String(b.password || ''), secret.admin_hash)) { this.fails.push(now); return this.json(res, 401, { error: 'Wrong password.' }); }
      return this.json(res, 200, { ok: true }, this.newSession(res));
    }
    if (!authed) return this.json(res, 401, { error: 'Sign in first.' });

    if (p === '/api/logout' && req.method === 'POST') {
      this.sessions.delete(this.session(req));
      return this.json(res, 200, { ok: true }, { 'set-cookie': 'edge_s=; Path=/; Max-Age=0' });
    }
    if (p === '/api/status') return this.json(res, 200, app.status());
    if (p === '/api/devices') {
      const counts = new Map(app.store.db.prepare('SELECT device_id d, count(*) n, sum(selected) s FROM points WHERE missing=0 GROUP BY device_id').all().map(r => [r.d, r]));
      return this.json(res, 200, app.store.devices().map(d => ({ ...d, points: counts.get(d.id)?.n || 0, selected: counts.get(d.id)?.s || 0 })));
    }
    if (p === '/api/points') {
      if (req.method === 'POST') {
        const b = await this.body(req);
        app.store.updatePoints(Array.isArray(b.changes) ? b.changes : []);
        app.scheduler.invalidate();
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 200, app.store.points(Number(url.searchParams.get('device')) || undefined));
    }
    if (p === '/api/recent') return this.json(res, 200, app.store.recent(Number(url.searchParams.get('point')), 50));
    if (p === '/api/scan' && req.method === 'POST') {
      if (app.scanner.state.running) return this.json(res, 409, { error: 'A scan is already running.' });
      const b = await this.body(req);
      app.scanner.run('manual', { browseAll: !!b.browse_all }).then(() => app.scheduler.invalidate()).catch(() => {});
      return this.json(res, 200, { started: true });
    }
    if (p === '/api/pair' && req.method === 'POST') {
      const b = await this.body(req);
      try { return this.json(res, 200, await app.link.pair(b.url, b.code)); } catch (e) { return this.json(res, 400, { error: e.message }); }
    }
    if (p === '/api/unpair' && req.method === 'POST') { app.link.unpair(); return this.json(res, 200, { ok: true }); }
    if (p === '/api/upload-now' && req.method === 'POST') { app.uploader.tick(true).catch(() => {}); return this.json(res, 200, { ok: true }); }
    if (p === '/api/log') return this.json(res, 200, app.logs.slice(-300));
    if (p === '/api/settings') {
      if (req.method === 'POST') {
        const b = await this.body(req);
        try { await app.applySettings(b); } catch (e) { return this.json(res, 400, { error: e.message }); }
      }
      return this.json(res, 200, app.publicSettings());
    }
    return this.json(res, 404, { error: 'not found' });
  }

  static(p, res) {
    if (p === '/') p = '/index.html';
    const f = path.normalize(path.join(WEB, p));
    if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'",
      'x-frame-options': 'DENY', 'cache-control': 'no-cache',
    });
    fs.createReadStream(f).pipe(res);
  }
}

module.exports = { Web, hashPw, checkPw };
