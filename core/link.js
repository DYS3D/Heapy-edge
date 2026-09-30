'use strict';
// Pairing and check-in with the central HEAPY Trend Tracker server
// (contracts/upload-api.json). Everything is outbound HTTPS from the box.

class Link {
  constructor({ config, store, log, health, boxInfo, onConfig }) {
    Object.assign(this, { config, store, log, health, boxInfo, onConfig });
    this.state = { last_checkin: null, last_error: null, config_version: store.getMeta('config_version', 0) };
    this.lastRun = 0;
  }

  server() { return (this.config.get().destinations || []).find(d => d.type === 'https' && d.name === 'server'); }

  async pair(url, code) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error('Server address must start with https://');
    if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) && !process.env.HEAPY_EDGE_ALLOW_HTTP) {
      throw new Error('Use https:// for the server address');
    }
    const res = await fetch(new URL('/api/edge/v1/pair', url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim(), box: this.boxInfo() }), signal: AbortSignal.timeout(30000),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? 'The pairing code was not accepted. Make a new code in Trend Tracker and try again.' : `Server said ${res.status}: ${txt.slice(0, 200)}`);
    const j = JSON.parse(txt);
    this.config.setSecret({ box_id: j.box_id, key: j.key, site: j.site || null, paired_at: Date.now(), server: url });
    const dests = (this.config.get().destinations || []).map(d => d.name === 'server' ? { ...d, url, enabled: true } : d);
    this.config.update({ destinations: dests });
    this.log('info', `paired with ${url} as ${j.box_id}${j.site ? ' (' + j.site + ')' : ''}`);
    return { box_id: j.box_id, site: j.site || null };
  }

  unpair() {
    this.config.setSecret({ box_id: null, key: null, site: null, paired_at: null });
    const dests = (this.config.get().destinations || []).map(d => d.name === 'server' ? { ...d, enabled: false } : d);
    this.config.update({ destinations: dests });
    this.log('info', 'unpaired from the server');
  }

  async tick(force = false) {
    const s = this.config.get();
    const srv = this.server();
    const sec = this.config.secret();
    if (!srv || !srv.enabled || !srv.url || !sec.key) return;
    if (!force && Date.now() - this.lastRun < (s.upload.checkin_every_s || 300) * 1000) return;
    this.lastRun = Date.now();
    try {
      const res = await fetch(new URL('/api/edge/v1/checkin', srv.url), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sec.key}` },
        body: JSON.stringify({ box: this.boxInfo(), health: this.health(), config_version: this.state.config_version }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const j = await res.json();
      this.state.last_checkin = Date.now(); this.state.last_error = null;
      if (j.config && j.config_version > this.state.config_version) {
        await this.onConfig(j.config);
        this.state.config_version = j.config_version;
        this.store.setMeta('config_version', j.config_version);
        this.log('info', `settings version ${j.config_version} from the server applied`);
      }
      if (j.update) this.state.update_offered = j.update; // installed by the updater (Phase 3)
    } catch (e) {
      this.state.last_error = e.message;
    }
  }
}

module.exports = { Link };
