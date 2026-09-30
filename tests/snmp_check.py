"""
HEAPY Edge - SNMP driver check against the simulator: every point on every agent
(v1, v2c, v3 authPriv) must read exactly the value served.

  python3 tests/snmp_check.py --sim-info sim.json [--rounds 2] [--walk]
Prints one JSON line; exit code 0 = pass.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modbus_check import Drv as _Drv, ok_value  # noqa: E402


class Drv(_Drv):
    async def start(self):
        self.p = await asyncio.create_subprocess_exec(sys.executable, os.path.join(ROOT, "drivers", "snmp", "driver.py"),
                                                      stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                      stderr=open("/tmp/snmp-check-driver.err", "a"), limit=1 << 24)
        self.waiting = {}
        asyncio.create_task(self._pump())


def settings(info, extra_points, walk=False):
    devs = []
    for d in info["devices"]:
        dv = {k: d[k] for k in ("name", "host", "port", "version") if k in d}
        if d.get("v3"):
            dv["v3"] = d["v3"]
        else:
            dv["community"] = d.get("community", "public")
        dv["template"] = "ups-mib"
        dv["points"] = [{"name": "sysUpTime", "oid": "1.3.6.1.2.1.1.3.0", "scale": 0.01}] + extra_points
        if walk:
            dv["walk"] = ["1.3.6.1.4.1.99999"]
        devs.append(dv)
    return {"devices": devs}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim-info", required=True)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--walk", action="store_true")
    a = ap.parse_args()
    info = json.load(open(a.sim_info))
    exp_all = json.loads(subprocess.run([sys.executable, os.path.join(ROOT, "sim", "snmp_sim.py"), "--print-expected"],
                                        capture_output=True, text=True).stdout)
    exp = exp_all["expected"]
    d = Drv()
    await d.start()
    await d.call("hello")
    r, _ = await d.call("configure", settings=settings(info, exp_all["extra_points"], a.walk))
    assert r["ok"] and not r["result"]["warnings"], r
    r, ev = await d.call("discover")
    devices = [e["data"] for e in ev if e["event"] == "device"]
    problems, names = [], {}
    for dev in devices:
        r, ev = await d.call("browse", device=dev)
        pts = [e["data"] for e in ev if e["event"] == "point"]
        want = len(exp) + (1 if a.walk else 0)  # the walk adds the counter32 twin? no: only new OIDs
        names[dev["key"]] = {p["key"]: p["name"] for p in pts if p["name"] in exp}
        if len(names[dev["key"]]) != len(exp):
            problems.append(f"{dev['name']}: {len(names[dev['key']])} points, expected {len(exp)}")
    t_read, reads = 0.0, 0
    for rnd in range(a.rounds):
        async def one(dev):
            nonlocal t_read, reads
            by = names[dev["key"]]
            t = time.monotonic()
            r, _ = await d.call("read", device=dev, points=list(by), rate=0)
            t_read += time.monotonic() - t
            reads += 1
            if not r["ok"]:
                problems.append(f"round {rnd} {dev['name']}: {r['error']}")
                return
            static = next((x for x in info["devices"] if x["name"] == dev["name"]), {}).get("static")
            for v in r["result"]["values"]:
                n = by[v["point"]]
                w = exp[n]
                if static and n == "Output load":
                    w = 30
                if n == "counter64" and dev["meta"]["version"] == "1":
                    w = None  # SNMP v1 has no 64-bit counters
                if not ok_value(w, v["v"]):
                    problems.append(f"round {rnd} {dev['name']} {n}: got {v['v']} ({v.get('error')}), want {w}")
        await asyncio.gather(*(one(dv) for dv in devices))
    print(json.dumps({"pass": not problems, "devices": len(devices), "reads": reads,
                      "avg_read_s": round(t_read / max(1, reads), 3), "problems": problems[:30]}))
    d.p.kill()
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    asyncio.run(main())
