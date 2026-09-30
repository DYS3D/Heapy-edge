'use strict';
// Starts one protocol driver program and talks to it over JSON lines
// (contracts/driver-protocol.json). Restarts it if it stops.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

class DriverHost extends EventEmitter {
  constructor(name, cfg, log) {
    super();
    this.name = name;
    this.cfg = cfg;           // { cmd: [..], settings: {...} }
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, onEvent, timer, op }
    this.proc = null;
    this.ready = false;
    this.info = null;
    this.restarts = 0;
    this.stopping = false;
    this.startedAt = 0;
  }

  async start() {
    this.stopping = false;
    const [cmd, ...args] = this.cfg.cmd;
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.startedAt = Date.now();
    const p = this.proc;
    readline.createInterface({ input: p.stdout }).on('line', line => this._line(line));
    readline.createInterface({ input: p.stderr }).on('line', line => this.log('info', `${this.name}: ${line}`));
    p.on('exit', (code, sig) => this._exit(code, sig));
    p.on('error', e => this.log('error', `${this.name} could not start: ${e.message}`));
    this.info = await this.call('hello', {}, { timeoutMs: 15000 });
    await this.call('configure', { settings: this.cfg.settings || {} }, { timeoutMs: 20000 });
    this.ready = true;
    this.log('info', `${this.name} driver ${this.info.version} ready`);
    this.emit('ready');
    return this.info;
  }

  _line(line) {
    let m;
    try { m = JSON.parse(line); } catch { this.log('warn', `${this.name}: bad line from driver`); return; }
    if (m.event) {
      const pend = m.id != null ? this.pending.get(m.id) : null;
      if (pend && pend.onEvent) {
        pend.onEvent(m.event, m.data);
        if (pend.idleMs) this._arm(m.id, pend); // activity keeps a long job alive
      } else if (m.event === 'log') {
        this.log(m.data.level || 'info', `${this.name}: ${m.data.msg}`);
      } else this.emit(m.event, m.data);
      return;
    }
    const pend = this.pending.get(m.id);
    this.hostTimeouts = 0; // the driver is alive
    if (!pend) return;
    this.pending.delete(m.id);
    clearTimeout(pend.timer);
    if (m.ok) pend.resolve(m.result);
    else {
      const e = new Error(m.error?.message || 'driver error');
      e.code = m.error?.code || 'internal';
      pend.reject(e);
    }
  }

  _arm(id, pend) {
    clearTimeout(pend.timer);
    pend.timer = setTimeout(() => {
      this.pending.delete(id);
      const e = new Error(`${pend.op} timed out`); e.code = 'timeout';
      pend.reject(e);
      // a driver that stops answering altogether is stuck: restart it
      this.hostTimeouts = (this.hostTimeouts || 0) + 1;
      if (this.hostTimeouts >= 3 && this.proc && this.proc.exitCode === null) {
        this.log('error', `${this.name} driver stopped answering; restarting it`);
        this.hostTimeouts = 0;
        try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, pend.idleMs || pend.timeoutMs);
  }

  _exit(code, sig) {
    this.ready = false;
    for (const [id, pend] of this.pending) {
      clearTimeout(pend.timer);
      const e = new Error('driver stopped'); e.code = 'internal';
      pend.reject(e);
      this.pending.delete(id);
    }
    if (this.stopping) return;
    this.restarts++;
    const wait = Math.min(60000, 1000 * 2 ** Math.min(this.restarts, 6));
    this.log('error', `${this.name} driver stopped (code ${code}${sig ? ', ' + sig : ''}); restarting in ${wait / 1000}s`);
    setTimeout(() => this.start().catch(e => this.log('error', `${this.name} restart failed: ${e.message}`)), wait);
    this.emit('down');
  }

  call(op, args = {}, { onEvent, timeoutMs = 60000, idleMs = 0 } = {}) {
    if (!this.proc || this.proc.exitCode !== null) return Promise.reject(Object.assign(new Error('driver not running'), { code: 'internal' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pend = { resolve, reject, onEvent, timeoutMs, idleMs, op };
      this.pending.set(id, pend);
      this._arm(id, pend);
      this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  async stop() {
    this.stopping = true;
    if (!this.proc || this.proc.exitCode !== null) return;
    try { await this.call('shutdown', {}, { timeoutMs: 6000 }); } catch { /* ignore */ }
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
  }
}

module.exports = { DriverHost };
