'use strict';
// HEAPY Edge fault tests for the oBIX driver (Niagara stations) (Linux root).
//   node tests/faults-obix.js [--only "a|b"] [--out file]
const path = require('node:path');
const { Lab, sleep, ROOT } = require('./lab');
const { kit, lastRead, lastPointRead, status, wrongValues, faultWindow, outage, commonTail } = require('./faultkit');

const { test, assert, finish } = kit('oBIX', path.join(ROOT, 'fault-report-obix.json'));
const K = n => `obix://${n}`;
const ERR = /Plant\/points\/(Faulty|Down|NaN)$/;

(async () => {
  const lab = new Lab({ kind: 'obix', net: 'bas-ob', prefix: '10.78.7', ips: 6, servers: 3, webPort: 18778, ignorePoint: k => ERR.test(k) });
  await lab.startSim(); await lab.startServer(); await lab.startBox();
  const exp = lab.expected;
  const expectFor = r => { const m = /BacnetNetwork\/(.+)$/.exec(r.description || ''); return m ? exp[m[1]] : undefined; };
  const N = lab.simInfo.devices.length;
  const keys = lab.simInfo.devices.map(d => K(d.name));
  let T0;
  try {
    await test('baseline: stations browsed (folders, refs, batch details) and every point read', async () => {
      const st = await lab.waitFor(async () => { const s = await lab.boxStatus(); return s.scan.last_result && !s.scan.running && s; }, 180000, 'scan');
      assert(st.scan.last_result.devices === N, `found ${st.scan.last_result.devices} of ${N}`);
      const all = lab.q('SELECT key FROM points WHERE missing=0');
      assert(all.length === N * Object.keys(exp).length, `${all.length} points, expected ${N * Object.keys(exp).length}`);
      const good = all.filter(p => !ERR.test(p.key)).length;
      await lab.waitFor(() => lab.q('SELECT count(*) n FROM (SELECT p FROM samples GROUP BY p HAVING count(*)>=3)')[0].n === good, 180000, 'three readings of every point');
      T0 = Date.now();
      await sleep(30000);
      const g = lab.gaps(T0, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return { stations: N, points: good };
    });

    await test('every value correct (real, int, bool, enum by range; bad statuses reported)', async () => {
      const w = wrongValues(lab, expectFor);
      assert(w.checked > N * 40, `only ${w.checked} checked`);
      assert(!w.bad.length, `${w.bad.length} wrong: ${JSON.stringify(w.bad.slice(0, 5))}`);
      const errs = lab.q('SELECT key, last_error FROM points WHERE last_error IS NOT NULL');
      assert(errs.length === 3 * N && errs.every(e => ERR.test(e.key)), JSON.stringify(errs.slice(0, 5)));
      return { values_checked: w.checked, error_points: errs.length };
    });

    await test('station powered off 30 s, then back', () => outage(lab, { dev: 'jace-01', key: K('jace-01'), assert }));
    await test('station stops answering (hung) 40 s', () => outage(lab, { dev: 'jace-02', key: K('jace-02'), f: 'hang', secs: 40, waitOffline: false, assert }));
    await test('slow replies (2 s)', () => faultWindow(lab, { devs: ['jace-01', 'jace-03'], f: 'slow', v: 2, expectFor, assert }));
    await test('15% HTTP 500 errors', () => faultWindow(lab, { devs: ['jace-01', 'jace-02'], f: 'err500', v: 0.15, expectFor, assert }));
    await test('10% broken XML replies', () => faultWindow(lab, { devs: ['jace-02', 'jace-03'], f: 'garbage', v: 0.1, expectFor, assert }));
    await test('15% of connections dropped without a reply', () => faultWindow(lab, { devs: ['jace-01', 'jace-03'], f: 'drop', v: 0.15, expectFor, assert }));
    await test('15% "busy" (HTTP 503) replies', () => faultWindow(lab, { devs: ['jace-02'], f: 'busy', v: 0.15, expectFor, assert }));

    await test('batch replies missing an item are not trusted (no values shifted onto the wrong point)', async () => {
      const t = Date.now();
      for (const k of keys.filter(k => k.endsWith('jace-03'))) lab.fault(k, t, null, 'short batch');
      await lab.simctl({ cmd: 'fault', dev: 'jace-03', f: 'shortbatch', on: true });
      await sleep(45000);
      await lab.simctl({ cmd: 'fault', dev: 'jace-03', f: 'shortbatch', on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastRead(lab, K('jace-03')) > back, 90000, 'readings again');
      const w = wrongValues(lab, expectFor, t);
      assert(!w.bad.length, `${w.bad.length} wrong values: ${JSON.stringify(w.bad.slice(0, 3))}`);
      return { values_checked: w.checked };
    });

    await test('a point goes into fault, then recovers; the station stays online', async () => {
      const t = Date.now();
      const p = 'Drivers/BacnetNetwork/AHU2/points/SupplyTemp/';
      const key = K('jace-02') + '/config/' + p.replace(/\/$/, '');
      await lab.simctl({ cmd: 'fault', dev: 'jace-02', f: 'status', v: p, on: true }); lab.fault(key, t, null, 'point fault');
      await lab.waitFor(() => (lab.q('SELECT last_error FROM points WHERE key=?', key)[0] || {}).last_error === 'point status fault', 60000, 'point error shown');
      await lab.simctl({ cmd: 'fault', dev: 'jace-02', f: 'status', v: p, on: false });
      const back = Date.now(); lab.faults.at(-1).to = back;
      await lab.waitFor(() => lastPointRead(lab, key) > back, 60000, 'point back');
      assert(status(lab, K('jace-02')) === 'online', 'station marked down for one point');
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    });

    await test('5% TCP packet loss on the network for 2 min', async () => {
      const t = Date.now();
      lab.lossOn(0.05, 'tcp');
      await sleep(120000);
      lab.lossOff();
      await sleep(20000);
      const g = lab.gaps(t, Date.now());
      assert(!g.length, `${g.length} gaps: ${JSON.stringify(g.slice(0, 3))}`);
      return {};
    });

    await commonTail(lab, { test, assert, keys, expectFor, T0: () => T0, rateMax: 8 });
  } finally { await lab.close(); }
  finish();
})();
