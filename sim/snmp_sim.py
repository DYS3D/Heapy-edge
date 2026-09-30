"""
HEAPY Edge - simulated SNMP site (UPSs, PDUs) for testing and stress testing.

  * SNMP v2c and v1 agents written here (one per IP address, UDP 161), so faults
    can be injected into single replies
  * one SNMP v3 agent (authPriv, SHA + AES) run by snmpsim, a separate agent
    implementation, serving the same values

Every agent serves the UPS-MIB (RFC 1628) values in VALUES plus a few awkward
extras, so the tests know exactly what each point must read.

  ip netns exec bas-snmp python3 snmp_sim.py --base 10.78.5. --agents 6 --control /tmp/snmp.sock

Control socket (JSON lines): {"cmd":"fault","dev":"ups-01","f":"drop","v":0.1,"on":true}
  faults: offline (no packets), reboot (v = seconds; uptime restarts), drop, slow (v = s),
  garbage, stale (an old reply first), dup (reply twice), toobig (v = most OIDs per reply),
  generr (v = share answered with genErr), community (v = new community: ours stops working)
  {"cmd":"stats"}  {"cmd":"list"}
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import math
import os
import random
import signal
import subprocess
import sys
import tempfile
import time

from pyasn1.codec.ber import decoder, encoder
from pysnmp.proto import api, rfc1902

UPS = "1.3.6.1.2.1.33.1."
EXTRA = "1.3.6.1.4.1.99999.1."
T0 = time.time()

# oid: (type, value); "dyn:*" values change over time
VALUES = {
    "1.3.6.1.2.1.1.1.0": ("str", "HEAPY lab UPS 3000"),
    "1.3.6.1.2.1.1.3.0": ("ticks", "dyn:uptime"),
    "1.3.6.1.2.1.1.5.0": ("str", "lab-ups"),
    UPS + "2.1.0": ("int", 2), UPS + "2.2.0": ("int", 0), UPS + "2.3.0": ("int", 42), UPS + "2.4.0": ("int", 100),
    UPS + "2.5.0": ("int", 545), UPS + "2.7.0": ("int", 27), UPS + "3.3.1.2.1": ("int", 600), UPS + "3.3.1.3.1": ("int", 120),
    UPS + "4.1.0": ("int", 3), UPS + "4.2.0": ("int", 600), UPS + "4.4.1.2.1": ("int", 120), UPS + "4.4.1.3.1": ("int", 83),
    UPS + "4.4.1.4.1": ("int", 950), UPS + "4.4.1.5.1": ("int", "dyn:load"), UPS + "6.1.0": ("gauge", 0),
    EXTRA + "1.0": ("str", "23.5"), EXTRA + "2.0": ("str", "OK"), EXTRA + "3.0": ("c64", 2 ** 40 + 7),
    EXTRA + "4.0": ("gauge", 4000000000), EXTRA + "6.0": ("int", -15), EXTRA + "7.0": ("c32", "dyn:counter"),
}
# what the driver must report (after the ups-mib template's scaling); None = must be an error
EXPECTED = {
    "Battery status": 2, "Seconds on battery": 0, "Minutes remaining": 42, "Charge remaining": 100,
    "Battery voltage": 54.5, "Battery temperature": 27, "Input frequency": 60, "Input voltage": 120,
    "Output source": 3, "Output frequency": 60, "Output voltage": 120, "Output current": 8.3,
    "Output power": 950, "Output load": "range:20:40", "Alarms present": 0, "sysUpTime": "any",
    "text-number": 23.5, "text-word": None, "counter64": 2 ** 40 + 7, "gauge-big": 4000000000,
    "missing": None, "negative": -15, "counter32": "any",
}
EXTRA_POINTS = [
    {"name": "text-number", "oid": EXTRA + "1.0"}, {"name": "text-word", "oid": EXTRA + "2.0"},
    {"name": "counter64", "oid": EXTRA + "3.0"}, {"name": "gauge-big", "oid": EXTRA + "4.0"},
    {"name": "missing", "oid": EXTRA + "5.0"}, {"name": "negative", "oid": EXTRA + "6.0"},
    {"name": "counter32", "oid": EXTRA + "7.0"},
]


def oid_key(o: str):
    return tuple(int(x) for x in o.split("."))


ORDER = sorted(VALUES, key=oid_key)


class Agent(asyncio.DatagramProtocol):
    def __init__(self, name, ip, version, community="public"):
        self.name, self.ip, self.version, self.community = name, ip, version, community
        self.faults = {}
        self.boot = time.time()
        self.prev = None
        self.stats = {"requests": 0, "answered": 0, "max_rate": 0}
        self._win = []
        self.tr = None

    def roll(self, k):
        v = self.faults.get(k)
        return bool(v) and random.random() < float(v)

    def value(self, oid):
        typ, v = VALUES[oid]
        if isinstance(v, str) and v.startswith("dyn:"):
            now = time.time()
            v = {"dyn:uptime": int((now - self.boot) * 100), "dyn:load": int(30 + 10 * math.sin((now - T0) / 40)),
                 "dyn:counter": int((now - self.boot) * 10) & 0xFFFFFFFF}[v]
        return {"str": lambda x: rfc1902.OctetString(x), "int": rfc1902.Integer, "gauge": rfc1902.Gauge32,
                "ticks": rfc1902.TimeTicks, "c64": rfc1902.Counter64, "c32": rfc1902.Counter32}[typ](v)

    def connection_made(self, tr):
        self.tr = tr

    def datagram_received(self, data, addr):
        if self.faults.get("offline"):
            return
        try:
            ver = int(api.decodeMessageVersion(data))
            p = api.PROTOCOL_MODULES[ver]
            req, _ = decoder.decode(data, asn1Spec=p.Message())
        except Exception:
            return
        if (ver == 0) != (self.version == "1"):
            return  # this agent only speaks its own version
        if str(p.apiMessage.get_community(req)) != self.community:
            return  # wrong community: real agents stay silent
        if self.roll("drop"):
            return
        now = time.monotonic()
        self._win = [t for t in self._win if now - t < 1] + [now]
        self.stats["max_rate"] = max(self.stats["max_rate"], len(self._win))
        self.stats["requests"] += 1
        asyncio.get_running_loop().create_task(self.reply(p, req, addr))

    async def reply(self, p, req, addr):
        pdu = p.apiMessage.get_pdu(req)
        rsp = p.apiMessage.get_response(req)
        rpdu = p.apiMessage.get_pdu(rsp)
        vbs_in = p.apiPDU.get_varbinds(pdu)
        out, err, eidx = [], 0, 0
        kind = pdu.tagSet
        get = kind == p.GetRequestPDU.tagSet
        nxt = kind == p.GetNextRequestPDU.tagSet
        bulk = self.version != "1" and kind == p.GetBulkRequestPDU.tagSet
        limit = self.faults.get("toobig")
        if limit and len(vbs_in) > int(limit):
            err = 1
        elif self.roll("generr"):
            err, eidx = 5, 1
        elif get:
            for i, (oid, _) in enumerate(vbs_in):
                o = str(oid)
                if o in VALUES and not (self.version == "1" and VALUES[o][0] == "c64"):  # no Counter64 in v1
                    out.append((oid, self.value(o)))
                elif self.version == "1":
                    err, eidx = 2, i + 1  # noSuchName
                    break
                else:
                    out.append((oid, p.NoSuchInstance()))
        elif nxt or bulk:
            reps = p.apiBulkPDU.get_max_repetitions(pdu) if bulk else 1
            for oid, _ in vbs_in:
                cur = oid_key(str(oid))
                n = 0
                for o in ORDER:
                    if self.version == "1" and VALUES[o][0] == "c64":
                        continue
                    if oid_key(o) > cur:
                        out.append((rfc1902.ObjectName(o), self.value(o)))
                        cur = oid_key(o)
                        n += 1
                        if n >= reps:
                            break
                if n == 0:
                    if self.version == "1":
                        err, eidx = 2, 1
                    else:
                        out.append((oid, p.EndOfMibView()))
        else:
            return
        if err:
            p.apiPDU.set_error_status(rpdu, err)
            p.apiPDU.set_error_index(rpdu, eidx)
            p.apiPDU.set_varbinds(rpdu, vbs_in)
        else:
            p.apiPDU.set_varbinds(rpdu, out)
        wire = encoder.encode(rsp)
        slow = float(self.faults.get("slow") or 0)
        await asyncio.sleep(0.002 + slow)
        if self.roll("stale") and self.prev:
            self.tr.sendto(self.prev, addr)
        if self.roll("garbage"):
            wire = bytes(random.randrange(256) for _ in range(random.randint(5, 60)))
        self.tr.sendto(wire, addr)
        if self.roll("dup"):
            self.tr.sendto(wire, addr)
        self.prev = wire
        self.stats["answered"] += 1


def fw(args):
    subprocess.run(["iptables"] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def set_offline(ip, on):
    a = "-I" if on else "-D"
    fw([a, "INPUT", "-d", ip, "-p", "udp", "--dport", "161", "-j", "DROP"])


def snmprec(path):
    tags = {"str": "4", "int": "2", "gauge": "66", "ticks": "67", "c64": "70", "c32": "65"}
    with open(path, "w") as f:
        for o in ORDER:
            typ, v = VALUES[o]
            if isinstance(v, str) and v.startswith("dyn:"):
                v = {"dyn:uptime": 12345, "dyn:load": 30, "dyn:counter": 777}[v]
            f.write(f"{o}|{tags[typ]}|{v}\n")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="10.78.5.")
    ap.add_argument("--first", type=int, default=10)
    ap.add_argument("--agents", type=int, default=6, help="v2c/v1 agents (every third one is v1)")
    ap.add_argument("--v3", action="store_true", help="also run an SNMP v3 agent (snmpsim)")
    ap.add_argument("--control", default="")
    ap.add_argument("--print-expected", action="store_true")
    a = ap.parse_args()
    if a.print_expected:
        print(json.dumps({"expected": EXPECTED, "extra_points": EXTRA_POINTS}))
        return
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)
    except Exception:
        pass
    loop = asyncio.get_running_loop()
    agents, info = {}, []
    ip = a.first
    for i in range(1, a.agents + 1):
        ver = "1" if i % 3 == 0 else "2c"
        name = f"ups-{i:02d}"
        addr = f"{a.base}{ip}"
        ip += 1
        ag = Agent(name, addr, ver)
        await loop.create_datagram_endpoint(lambda ag=ag: ag, local_addr=(addr, 161))
        agents[name] = ag
        info.append({"name": name, "host": addr, "port": 161, "version": ver, "community": "public"})
    v3proc = None
    if a.v3:
        addr = f"{a.base}{ip}"
        d = tempfile.mkdtemp(prefix="snmpsim-")
        snmprec(os.path.join(d, "public.snmprec"))
        v3proc = subprocess.Popen(["snmpsim-command-responder", "--data-dir", d, "--agent-udpv4-endpoint", f"{addr}:161",
                                   "--v3-user", "heapy", "--v3-auth-key", "labauthkey1", "--v3-auth-proto", "SHA",
                                   "--v3-priv-key", "labprivkey1", "--v3-priv-proto", "AES", "--process-user", "root",
                                   "--process-group", "root", "--cache-dir", d],
                                  stdout=subprocess.DEVNULL, stderr=open(os.path.join(d, "log"), "w"),
                                  preexec_fn=lambda: ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL))
        info.append({"name": "ups-v3", "host": addr, "port": 161, "version": "3", "static": True,
                     "v3": {"user": "heapy", "auth": "SHA", "auth_key": "labauthkey1", "priv": "AES", "priv_key": "labprivkey1", "context": "public"}})
        await asyncio.sleep(3)

    async def control(reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                r = json.loads(line)
                out = {"ok": True}
                if r["cmd"] == "fault":
                    ag = agents[r["dev"]]
                    f, on = r["f"], r.get("on", True)
                    if f == "offline":
                        set_offline(ag.ip, on)
                    elif f == "reboot" and not on:
                        pass  # a reboot ends by itself
                    elif f == "reboot":
                        async def rb(ag=ag, secs=float(r.get("v", 20))):
                            set_offline(ag.ip, True)
                            await asyncio.sleep(secs)
                            ag.boot = time.time()
                            set_offline(ag.ip, False)
                        asyncio.create_task(rb())
                    elif f == "community":
                        ag.community = str(r.get("v")) if on else "public"
                    elif on:
                        ag.faults[f] = r.get("v", True)
                    else:
                        ag.faults.pop(f, None)
                elif r["cmd"] == "stats":
                    out["devices"] = {n: g.stats for n, g in agents.items()}
                elif r["cmd"] == "list":
                    out["devices"] = info
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
    try:
        await asyncio.Event().wait()
    finally:
        if v3proc:
            v3proc.kill()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
