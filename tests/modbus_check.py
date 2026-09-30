"""
HEAPY Edge - Modbus driver check against the simulator: every point on every
device must read exactly the value the simulator serves.

  python3 tests/modbus_check.py --sim-info sim.json [--rounds 3]
Prints one JSON line with the result; exit code 0 = pass.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def settings_from(info, profiles):
    conns, devs = {}, []
    for d in info["devices"]:
        c = dict(d["conn"])
        conns[c["name"]] = c
        dv = {"name": d["name"], "connection": c["name"], "unit": d["unit"], "template": d["profile"]}
        if d["profile"] == "tiny":
            dv["template"] = "meter"
        devs.append(dv)
    return {"connections": list(conns.values()), "devices": devs,
            "templates": {p: {"points": v["points"]} for p, v in profiles.items()}}


def profiles():
    out = {}
    for p in ("meter", "big"):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "sim", "modbus_sim.py"), "--template", p], capture_output=True, text=True)
        out[p] = json.loads(r.stdout)
    return out


def ok_value(want, got):
    if want is None:
        return got is None
    if isinstance(want, str):
        if want in ("rising", "any"):
            return isinstance(got, (int, float))
        if want.startswith("range:"):
            _, lo, hi = want.split(":")
            return isinstance(got, (int, float)) and float(lo) <= got <= float(hi)
    if isinstance(want, float) or isinstance(got, float):
        return got is not None and abs(got - want) <= abs(want) * 1e-6
    return got == want


class Drv:
    def __init__(self):
        self.p = None
        self.n = 0

    async def start(self):
        self.p = await asyncio.create_subprocess_exec(sys.executable, os.path.join(ROOT, "drivers", "modbus", "driver.py"),
                                                      stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                      stderr=open("/tmp/modbus-check-driver.err", "a"), limit=1 << 24)
        self.waiting = {}
        asyncio.create_task(self._pump())

    async def _pump(self):
        while True:
            line = await self.p.stdout.readline()
            if not line:
                return
            m = json.loads(line)
            q = self.waiting.get(m.get("id"))
            if q:
                q.put_nowait(m)

    async def call(self, op, timeout=120, **args):
        self.n += 1
        rid = self.n
        q = self.waiting[rid] = asyncio.Queue()
        self.p.stdin.write((json.dumps({"id": rid, "op": op, **args}) + "\n").encode())
        await self.p.stdin.drain()
        events = []
        end = time.monotonic() + timeout
        while True:
            m = await asyncio.wait_for(q.get(), max(0.1, end - time.monotonic()))
            if "event" in m:
                events.append(m)
                continue
            return m, events


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim-info", required=True)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    info = json.load(open(a.sim_info))
    profs = profiles()
    s = settings_from(info, profs)
    if a.only:
        s["devices"] = [d for d in s["devices"] if d["name"].startswith(tuple(a.only.split(",")))]
    exp_by = {p: v["expected"] for p, v in profs.items()}
    d = Drv()
    await d.start()
    await d.call("hello")
    r, _ = await d.call("configure", settings=s)
    assert r["ok"] and not r["result"]["warnings"], r
    r, ev = await d.call("discover")
    devices = [e["data"] for e in ev if e["event"] == "device"]
    problems, reads, t_read = [], 0, 0.0
    names = {}
    for dev in devices:
        r, ev = await d.call("browse", device=dev)
        pts = [e["data"] for e in ev if e["event"] == "point"]
        prof = next(x["profile"] for x in info["devices"] if x["name"] == dev["name"])
        exp = exp_by["big" if prof == "big" else "meter"]
        if len(pts) != len(exp):
            problems.append(f"{dev['name']}: {len(pts)} points, expected {len(exp)}")
        names[dev["key"]] = ({p["key"]: p["name"] for p in pts}, exp)
    for rnd in range(a.rounds):
        async def one(dev):
            nonlocal reads, t_read
            by, exp = names[dev["key"]]
            t = time.monotonic()
            r, _ = await d.call("read", device=dev, points=list(by), rate=0)
            t_read += time.monotonic() - t
            reads += 1
            if not r["ok"]:
                problems.append(f"round {rnd} {dev['name']}: {r['error']}")
                return
            for v in r["result"]["values"]:
                n = by[v["point"]]
                if not ok_value(exp[n], v["v"]):
                    problems.append(f"round {rnd} {dev['name']} {n}: got {v['v']} ({v.get('error')}), want {exp[n]}")
        await asyncio.gather(*(one(dv) for dv in devices))
    st, _ = await d.call("stats")
    print(json.dumps({"pass": not problems, "devices": len(devices), "reads": reads,
                      "avg_read_s": round(t_read / max(1, reads), 3), "problems": problems[:40],
                      "links": st.get("result")}))
    d.p.kill()
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    asyncio.run(main())
