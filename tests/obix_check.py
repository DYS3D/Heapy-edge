"""
HEAPY Edge - oBIX driver check against the simulated stations: every point
must read exactly the value served.   python3 tests/obix_check.py --sim-info sim.json
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modbus_check import Drv as _Drv, ok_value  # noqa: E402


class Drv(_Drv):
    async def start(self):
        self.p = await asyncio.create_subprocess_exec(sys.executable, os.path.join(ROOT, "drivers", "obix", "driver.py"),
                                                      stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                      stderr=open("/tmp/obix-check-driver.err", "a"), limit=1 << 24)
        self.waiting = {}
        asyncio.create_task(self._pump())


def expected_for(exp, desc):
    for path, w in exp.items():
        if desc.endswith("BacnetNetwork/" + path):
            return path, w
    return None, None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim-info", required=True)
    ap.add_argument("--rounds", type=int, default=2)
    a = ap.parse_args()
    info = json.load(open(a.sim_info))
    exp = json.loads(subprocess.run([sys.executable, os.path.join(ROOT, "sim", "obix_sim.py"), "--print-expected"],
                                    capture_output=True, text=True).stdout)["expected"]
    d = Drv()
    await d.start()
    await d.call("hello")
    r, _ = await d.call("configure", settings={"stations": info["devices"]})
    assert r["ok"], r
    r, ev = await d.call("discover")
    devices = [e["data"] for e in ev if e["event"] == "device"]
    problems, names = [], {}
    for dev in devices:
        if dev["meta"].get("error"):
            problems.append(f"{dev['name']}: {dev['meta']['error']}")
        r, ev = await d.call("browse", device=dev, rate=0)
        pts = [e["data"] for e in ev if e["event"] == "point"]
        names[dev["key"]] = {p["key"]: expected_for(exp, p["description"]) for p in pts}
        if len(pts) != len(exp):
            problems.append(f"{dev['name']}: {len(pts)} points, expected {len(exp)}")
    for rnd in range(a.rounds):
        for dev in devices:
            by = names[dev["key"]]
            r, _ = await d.call("read", device=dev, points=list(by), rate=0)
            if not r["ok"]:
                problems.append(f"round {rnd} {dev['name']}: {r['error']}")
                continue
            for v in r["result"]["values"]:
                n, w = by[v["point"]]
                if n is None or not ok_value(w, v["v"]):
                    problems.append(f"round {rnd} {dev['name']} {n}: got {v['v']} ({v.get('error')}), want {w}")
    print(json.dumps({"pass": not problems, "devices": len(devices), "problems": problems[:30]}))
    d.p.kill()
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    asyncio.run(main())
