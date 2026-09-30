"""
HEAPY Edge - Haystack driver check against the simulator: every point on every
server (SCRAM, basic, no login; JSON v3 and v4) must read exactly the value served.
  python3 tests/haystack_check.py --sim-info sim.json
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
        self.p = await asyncio.create_subprocess_exec(sys.executable, os.path.join(ROOT, "drivers", "haystack", "driver.py"),
                                                      stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                      stderr=open("/tmp/haystack-check-driver.err", "a"), limit=1 << 24)
        self.waiting = {}
        asyncio.create_task(self._pump())


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim-info", required=True)
    ap.add_argument("--rounds", type=int, default=2)
    a = ap.parse_args()
    info = json.load(open(a.sim_info))
    exp = json.loads(subprocess.run([sys.executable, os.path.join(ROOT, "sim", "haystack_sim.py"), "--print-expected"],
                                    capture_output=True, text=True).stdout)["expected"]
    d = Drv()
    await d.start()
    await d.call("hello")
    servers = [{k: s[k] for k in ("name", "url", "user", "password", "auth")} for s in info["devices"]]
    r, _ = await d.call("configure", settings={"servers": servers})
    assert r["ok"] and not r["result"]["warnings"], r
    r, ev = await d.call("discover")
    devices = [e["data"] for e in ev if e["event"] == "device"]
    problems, names = [], {}
    for dev in devices:
        if dev["meta"].get("error"):
            problems.append(f"{dev['name']}: {dev['meta']['error']}")
        r, ev = await d.call("browse", device=dev)
        if not r["ok"]:
            problems.append(f"{dev['name']} browse: {r['error']}")
            continue
        names[dev["key"]] = {e["data"]["key"]: e["data"]["name"] for e in ev if e["event"] == "point"}
        if len(names[dev["key"]]) != len(exp):
            problems.append(f"{dev['name']}: {len(names[dev['key']])} points, expected {len(exp)}")
    for rnd in range(a.rounds):
        for dev in devices:
            by = names.get(dev["key"]) or {}
            r, _ = await d.call("read", device=dev, points=list(by), rate=0)
            if not r["ok"]:
                problems.append(f"round {rnd} {dev['name']}: {r['error']}")
                continue
            for v in r["result"]["values"]:
                n = by[v["point"]]
                if not ok_value(exp[n], v["v"]):
                    problems.append(f"round {rnd} {dev['name']} {n}: got {v['v']} ({v.get('error')}), want {exp[n]}")
    print(json.dumps({"pass": not problems, "devices": len(devices), "problems": problems[:30]}))
    d.p.kill()
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    asyncio.run(main())
