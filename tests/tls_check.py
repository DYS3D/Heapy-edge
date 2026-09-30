"""
HEAPY Edge - TLS handling of the web drivers (Haystack here; oBIX uses the same client):
  * a self-signed certificate is refused by default, and the error names its fingerprint
  * pinning that fingerprint works; a wrong pin is refused
  * verify_tls false works but is reported as a warning
  python3 tests/tls_check.py --sim-info sim.json   (simulator started with --tls)
"""

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haystack_check import Drv  # noqa: E402


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim-info", required=True)
    a = ap.parse_args()
    s0 = json.load(open(a.sim_info))["devices"][0]
    base = {"name": "tls", "url": s0["tls_url"], "user": s0["user"], "password": s0["password"], "auth": "auto", "timeout_ms": 5000}
    problems = []

    async def attempt(extra):
        d = Drv()
        await d.start()
        try:
            r, _ = await d.call("configure", settings={"servers": [{**base, **extra}]})
            warns = r["result"]["warnings"]
            r, ev = await d.call("discover")
            dev = [e["data"] for e in ev if e["event"] == "device"][0]
            r, ev = await d.call("browse", device=dev)
            return r, warns
        finally:
            d.p.kill()

    r, _ = await attempt({})
    msg = (r.get("error") or {}).get("message", "")
    if r["ok"] or s0["tls_fingerprint"] not in msg:
        problems.append(f"self-signed certificate not refused with its fingerprint: {r}")
    r, _ = await attempt({"tls_fingerprint": s0["tls_fingerprint"]})
    if not r["ok"] or r["result"]["points"] < 10:
        problems.append(f"pinned certificate did not work: {r}")
    r, _ = await attempt({"tls_fingerprint": "00" * 32})
    if r["ok"] or r["error"]["code"] != "rejected":
        problems.append(f"wrong pin not refused: {r}")
    r, warns = await attempt({"verify_tls": False})
    if not r["ok"] or not any("certificate checks are off" in w for w in warns):
        problems.append(f"verify_tls false: {r} {warns}")
    print(json.dumps({"pass": not problems, "problems": problems}))
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    asyncio.run(main())
