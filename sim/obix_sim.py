"""
HEAPY Edge - simulated oBIX stations (shaped like Niagara JACEs) for testing.

Each station (own IP, HTTP port 80, HTTP Basic login) serves an oBIX lobby with the
batch operation, /obix/about/, and a Drivers/BacnetNetwork/<equip>/points/ tree.
Folders list points as refs carrying Niagara-style "is" contracts, so the driver
has to follow refs and read point details in batches.

  ip netns exec bas-ob python3 obix_sim.py --base 10.78.7. --stations 2 --control /tmp/ob.sock

Control (JSON lines): {"cmd":"fault","dev":"jace-01","f":"err500","v":0.1,"on":true}
  faults: offline, slow (v = s), err500, garbage, drop, busy, hang, status (v = point path:
  status fault), remove (v = point path: batch returns <err>), shortbatch (batch replies miss items)
  {"cmd":"stats"}
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
import json
import math
import os
import random
import signal
import subprocess
import time
from urllib.parse import unquote, urlsplit
from xml.sax.saxutils import quoteattr

T0 = time.time()
USER, PASSWORD = "heapy", "lab-Obix-Pass-1"
NS = 'xmlns="http://obix.org/ns/schema/1.0"'

# (path under Drivers/BacnetNetwork/, element, unit, value or dyn, extra attrs, expected)
POINTS = []
for e in range(1, 4):
    eq = f"AHU{e}/points/"
    POINTS += [
        (eq + "SupplyTemp", "real", "fahrenheit", 55.0 + e, {}, 55.0 + e),
        (eq + "ReturnTemp", "real", "fahrenheit", "dyn:wave", {}, "range:68:76"),
        (eq + "FanStatus", "bool", None, e % 2 == 1, {"trueText": "On", "falseText": "Off"}, int(e % 2 == 1)),
        (eq + "OccMode", "enum", None, "unoccupied", {"range": "/obix/config/Ranges/Occ/"}, 1),
        (eq + "Airflow", "real", "cubic_feet_per_minute", 10000 + e, {}, 10000 + e),
        (eq + "Setpoint", "int", None, 72, {}, 72),
    ]
POINTS += [
    ("Plant/points/KW", "real", "kilowatt", "dyn:counter", {}, "any"),
    ("Plant/points/Faulty", "real", "fahrenheit", 1.0, {"status": "fault"}, None),
    ("Plant/points/Down", "real", "fahrenheit", 1.0, {"status": "down"}, None),
    ("Plant/points/Alarmed", "real", "fahrenheit", 99.5, {"status": "alarm"}, 99.5),
    ("Plant/points/NaN", "real", "fahrenheit", "NaN", {}, None),
]
EXPECTED = {p[0]: p[5] for p in POINTS}  # by path under Drivers/BacnetNetwork/
OCC = ["occupied", "unoccupied", "bypass", "standby"]
HINT = {"real": "/obix/def/control:NumericPoint", "bool": "/obix/def/control:BooleanPoint",
        "enum": "/obix/def/control:EnumPoint", "int": "/obix/def/control:NumericPoint"}


class Station:
    def __init__(self, name, ip):
        self.name, self.ip = name, ip
        self.faults = {}
        self.status_fault, self.removed = set(), set()
        self.stats = {"requests": 0, "batches": 0, "max_rate": 0, "max_conns": 0}
        self._win = []
        self.conns = 0
        self.by_path = {"Drivers/BacnetNetwork/" + p[0] + "/": p for p in POINTS}

    def roll(self, k):
        v = self.faults.get(k)
        return bool(v) and random.random() < float(v)

    def point_xml(self, path, p, name=None):
        el, unit, v, extra = p[1], p[2], p[3], dict(p[4])
        if isinstance(v, str) and v.startswith("dyn:"):
            now = time.time()
            v = {"dyn:wave": round(72 + 3 * math.sin((now - T0) / 30), 2), "dyn:counter": round((now - T0) * 1.5, 1)}[v]
        if isinstance(v, bool):
            v = "true" if v else "false"
        if path in self.status_fault:
            extra["status"] = "fault"
        attrs = {"name": name or p[0].rsplit("/", 1)[-1], "href": f"/obix/config/{path}", "val": str(v),
                 "is": HINT[el] + " /obix/def/baja:StatusValue", **extra}
        if unit:
            attrs["unit"] = f"obix:units/{unit}"
        return f"<{el} " + " ".join(f"{k}={quoteattr(str(x))}" for k, x in attrs.items()) + "/>"

    def folder(self, path):
        kids = set()
        for full, p in self.by_path.items():
            if full.startswith(path) and full != path:
                rest = full[len(path):]
                kids.add(rest.split("/", 1)[0])
        if not kids:
            return None
        items = []
        for k in sorted(kids):
            sub = f"{path}{k}/"
            p = self.by_path.get(sub)
            if p:
                items.append(f'<ref name="{k}" href="{k}/" is="{HINT[p[1]]} /obix/def/control:ControlPoint"/>')
            else:
                items.append(f'<ref name="{k}" href="{k}/" is="/obix/def/baja:Folder"/>')
        return f'<obj {NS} href="/obix/config/{path}" is="/obix/def/baja:Folder">' + "".join(items) + "</obj>"

    def route(self, method, target, body):
        path = unquote(urlsplit(target).path)
        if not path.startswith("/obix/"):
            return 404, "<err/>"
        rel = path[len("/obix/"):]
        if rel == "":
            return 200, (f'<obj {NS} href="/obix/" is="obix:Lobby"><ref name="about" href="about/"/>'
                         '<ref name="config" href="config/"/><op name="batch" href="batch/" in="obix:BatchIn" out="obix:BatchOut"/></obj>')
        if rel == "about/":
            return 200, (f'<obj {NS} href="/obix/about/"><str name="serverName" val="{self.name}"/>'
                         '<str name="vendorName" val="Tridium"/><str name="productName" val="Niagara 4"/>'
                         '<str name="productVersion" val="4.13"/></obj>')
        if rel == "batch/" and method == "POST":
            self.stats["batches"] += 1
            import re as _re
            uris = [unquote(u) for u in _re.findall(r'<uri is="obix:Read" val="([^"]+)"', body.decode())]
            out = []
            for u in uris:
                cp = u[len("/obix/config/"):] if u.startswith("/obix/config/") else None
                p = self.by_path.get(cp) if cp else None
                if p is None or cp in self.removed:
                    out.append(f'<err is="obix:BadUriErr" display="Unresolved: {u}"/>')
                else:
                    out.append(self.point_xml(cp, p))
            if self.faults.get("shortbatch") and len(out) > 1:
                out = out[:-1]
            return 200, f'<list {NS} is="obix:BatchOut">' + "".join(out) + "</list>"
        if rel.startswith("config/"):
            cp = rel[len("config/"):]
            if cp == "Ranges/Occ/":
                return 200, f'<list {NS} is="obix:Range">' + "".join(f'<obj name="{n}" display="{n.title()}"/>' for n in OCC) + "</list>"
            p = self.by_path.get(cp)
            if p:
                return 200, self.point_xml(cp, p).replace(f"<{p[1]} ", f"<{p[1]} {NS} ", 1)
            f = self.folder(cp)
            if f:
                return 200, f
        return 404, f'<err {NS} is="obix:BadUriErr"/>'

    async def handle(self, reader, writer):
        self.conns += 1
        self.stats["max_conns"] = max(self.stats["max_conns"], self.conns)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                method, target, _ = line.decode("latin-1").split(" ", 2)
                hdrs = {}
                while True:
                    h = await reader.readline()
                    if h in (b"\r\n", b"\n", b""):
                        break
                    k, _, v = h.decode("latin-1").partition(":")
                    hdrs[k.strip().lower()] = v.strip()
                body = await reader.readexactly(int(hdrs.get("content-length", "0") or 0))
                now = time.monotonic()
                self._win = [t for t in self._win if now - t < 1] + [now]
                self.stats["max_rate"] = max(self.stats["max_rate"], len(self._win))
                self.stats["requests"] += 1
                if self.faults.get("hang"):
                    while await reader.read(1024):  # never answer; stop when the client gives up
                        pass
                    break
                if self.roll("drop"):
                    break
                await asyncio.sleep(0.003 + float(self.faults.get("slow") or 0))
                if hdrs.get("authorization") != "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode():
                    status, out = 401, "<err/>"
                else:
                    status, out = self.route(method, target, body)
                out = out.encode()
                if self.roll("garbage"):
                    status, out = 200, b"<list is=\"obix:BatchOut\"><real val=\"1\"" + bytes(random.randrange(32, 127) for _ in range(20))
                if self.roll("err500"):
                    status, out = 500, b"<html>error</html>"
                if self.roll("busy"):
                    status, out = 503, b"busy"
                head = f"HTTP/1.1 {status} X\r\nContent-Type: text/xml\r\nContent-Length: {len(out)}\r\n"
                if status == 401:
                    head += 'WWW-Authenticate: Basic realm="obix"\r\n'
                writer.write((head + "\r\n").encode() + out)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self.conns -= 1
            try:
                writer.close()
            except Exception:
                pass


def fw(args):
    subprocess.run(["iptables"] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="10.78.7.")
    ap.add_argument("--first", type=int, default=10)
    ap.add_argument("--stations", type=int, default=2)
    ap.add_argument("--control", default="")
    ap.add_argument("--print-expected", action="store_true")
    a = ap.parse_args()
    if a.print_expected:
        print(json.dumps({"expected": EXPECTED}))
        return
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)
    except Exception:
        pass
    st, info = {}, []
    for i in range(a.stations):
        name = f"jace-{i + 1:02d}"
        ip = f"{a.base}{a.first + i}"
        s = Station(name, ip)
        await asyncio.start_server(s.handle, ip, 80)
        st[name] = s
        info.append({"name": name, "url": f"http://{ip}/obix", "user": USER, "password": PASSWORD})

    async def control(reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                r = json.loads(line)
                out = {"ok": True}
                if r["cmd"] == "fault":
                    s = st[r["dev"]]
                    f, on, v = r["f"], r.get("on", True), r.get("v", True)
                    if f == "offline":
                        fw(["-I" if on else "-D", "INPUT", "-d", s.ip, "-p", "tcp", "--dport", "80", "-j", "DROP"])
                        fw(["-I" if on else "-D", "OUTPUT", "-s", s.ip, "-p", "tcp", "--sport", "80", "-j", "DROP"])
                    elif f == "status":
                        (s.status_fault.add if on else s.status_fault.discard)(v)
                    elif f == "remove":
                        (s.removed.add if on else s.removed.discard)(v)
                    elif on:
                        s.faults[f] = v
                    else:
                        s.faults.pop(f, None)
                elif r["cmd"] == "stats":
                    out["servers"] = {n: s.stats for n, s in st.items()}
                else:
                    raise ValueError(r["cmd"])
            except Exception as e:
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()

    if a.control:
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(control, path=a.control)
    print(json.dumps({"ready": True, "devices": info}), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
