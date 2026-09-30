'use strict';
// Settings for the site box, kept in <data>/settings.json. Secrets (the box
// key from pairing, the setup page password) live in <data>/secret.json, mode 600.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function defaults(dataDir) {
  return {
    name: 'HEAPY Edge',
    hardware: process.env.HEAPY_EDGE_HARDWARE || 'generic',
    web: { port: 8770, bind: '0.0.0.0' },
    drivers: {
      'bacnet-ip': {
        enabled: true,
        cmd: [process.env.HEAPY_EDGE_PYTHON || 'python3', path.join(ROOT, 'drivers', 'bacnet-ip', 'driver.py')],
        // BAS port: "host" = first interface; or "10.1.2.3/24"; foreign_bbmd for a remote BBMD
        settings: { address: 'host', instance: 4194001, name: 'HEAPY-Edge' },
        targets: {},                 // { ranges: [[0,4194303]], chunk: 0 }
        discover_timeout_s: 5,
        net_rate: 10,                // who-is per second on the network
        rate_per_device: 5,          // requests per second to one device
      },
    },
    scan: { at_start: true, every_h: 24, windows: ['any'], browse_every_h: 168, auto_select: 'all' },
    poll: {
      default_interval_s: 900, max_points_per_read: 200, max_parallel: 8,
      offline_after: 3, offline_retry_s: 300, use_cov: false, cov_heartbeat_s: 3600, cov_lifetime_s: 900,
    },
    upload: { every_s: 300, batch_max: 20000, checkin_every_s: 300 },
    buffer: { keep_days: 30, keep_days_unsent: 365, max_mb: 20000 },
    destinations: [
      { name: 'server', type: 'https', url: '', enabled: false },
      { name: 'files', type: 'file', dir: path.join(dataDir, 'outbox'), enabled: false },
    ],
  };
}

function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b === undefined ? a : b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
  return out;
}

class Config {
  constructor(dataDir, overrides = {}) {
    this.dataDir = dataDir;
    this.overrides = overrides; // fixed settings from the command line or tests; always win
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'settings.json');
    this.secretFile = path.join(dataDir, 'secret.json');
    this.load();
  }
  load() {
    let user = {};
    try { user = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.user = user;
    this.value = merge(merge(defaults(this.dataDir), user), this.overrides);
    try { this._secret = JSON.parse(fs.readFileSync(this.secretFile, 'utf8')); } catch { this._secret = {}; }
  }
  get() { return this.value; }
  // Change saved settings (only the keys given), keep the rest.
  update(patch) {
    this.user = merge(this.user, patch);
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.user, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
    this.value = merge(merge(defaults(this.dataDir), this.user), this.overrides);
    return this.value;
  }
  secret() { return this._secret; }
  setSecret(patch) {
    this._secret = { ...this._secret, ...patch };
    fs.writeFileSync(this.secretFile + '.tmp', JSON.stringify(this._secret, null, 2), { mode: 0o600 });
    fs.renameSync(this.secretFile + '.tmp', this.secretFile);
  }
}

module.exports = { Config, defaults, merge, ROOT };
