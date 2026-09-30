"""
HEAPY Edge - simulated Modbus site for testing and stress testing.

One process runs:
  * Modbus TCP devices, one per IP address (port 502)
  * Modbus TCP gateways (one IP, several unit ids behind it, one request at a time
    at serial speed, like a real TCP-to-RS-485 gateway)
  * an RTU-over-TCP serial server (raw RTU frames over TCP port 4001)
  * RTU devices on a virtual RS-485 bus (pseudo-terminals, see rs485_bus.py)

Every device serves the same register layout (LAYOUT below) so the tests know
exactly what each point must read. Some devices are "strict": reading an
address that does not exist returns exception 2, like most real meters.

Run inside the lab network namespace (see netsetup.sh):
  ip netns exec bas-mb python3 modbus_sim.py --base 10.78.0. --tcp 6 --gateways 1 --control /tmp/mb.sock

Control socket (one JSON object per line):
  {"cmd":"fault","dev":"tcp-01","f":"offline","on":true}
      faults: offline (powered off: no packets at all), reboot (v = seconds off),
      silent (connection works, never answers), slow (v = seconds), drop (v = share
      of requests not answered), busy (v = share answered with "busy"), garbage
      (v = share answered with random bytes), stale (v = share preceded by an old
      reply), partial (reply sent in pieces), close (v = share of replies after which
      the connection is closed), wrongunit (v = share answered with another unit id),
      gwfail (gateway: devices behind it unreachable, answered with exception 11)
  {"cmd":"bus","noise":5}  {"cmd":"bus","drop":0.001}  {"cmd":"bus","cut":0,"on":true}
  {"cmd":"stats"}   {"cmd":"list"}
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
import struct
import subprocess
import sys
import termios
import time
import tty

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from rs485_bus import Bus  # noqa: E402

T0 = time.time()


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def with_crc(f: bytes) -> bytes:
    return f + struct.pack("<H", crc16(f))


# ---- register layout ------------------------------------------------------------
def words(fmt: str, v, order: str = "ABCD"):
    b = struct.pack(">" + fmt, v)
    ws = [b[i:i + 2] for i in range(0, len(b), 2)]
    if order in ("CDAB", "DCBA"):
        ws.reverse()
    if order in ("BADC", "DCBA"):
        ws = [w[::-1] for w in ws]
    return [struct.unpack(">H", w)[0] for w in ws]


# (name, table, address, type, order, raw value, extra point settings, expected reading)
LAYOUT = [
    ("f32-abcd", "holding", 0, "f32", "ABCD", 123.25, {}, 123.25),
    ("f32-cdab", "holding", 2, "f32", "CDAB", 123.25, {}, 123.25),
    ("f32-badc", "holding", 4, "f32", "BADC", -45.5, {}, -45.5),
    ("f32-dcba", "holding", 6, "f32", "DCBA", 1000000.0, {}, 1000000),
    ("u16", "holding", 8, "u16", "ABCD", 40000, {}, 40000),
    ("i16", "holding", 9, "i16", "ABCD", -1234, {}, -1234),
    ("u32", "holding", 10, "u32", "ABCD", 3000000000, {}, 3000000000),
    ("i32-cdab", "holding", 12, "i32", "CDAB", -123456, {}, -123456),
    ("f64", "holding", 14, "f64", "ABCD", 12345.678901, {}, 12345.678901),
    ("u64", "holding", 18, "u64", "ABCD", 2 ** 40 + 5, {}, 2 ** 40 + 5),
    ("status-bit0", "holding", 22, "bit", "ABCD", 0x8005, {"bit": 0}, 1),
    ("status-bit1", "holding", 22, "bit", "ABCD", 0x8005, {"bit": 1}, 0),
    ("status-bit15", "holding", 22, "bit", "ABCD", 0x8005, {"bit": 15}, 1),
    ("scaled", "holding", 23, "u16", "ABCD", 725, {"scale": 0.1, "units": "degrees-fahrenheit"}, 72.5),
    ("offset", "holding", 24, "i16", "ABCD", -40, {"offset": 32}, -8),
    ("not-available", "holding", 25, "u16", "ABCD", 65535, {"invalid": [65535]}, None),
    ("nan", "holding", 26, "f32", "ABCD", float("nan"), {}, None),
    ("runtime-s", "holding", 30, "u32", "ABCD", "counter", {"units": "seconds"}, "rising"),
    ("temp", "holding", 32, "f32", "ABCD", "wave", {"units": "degrees-fahrenheit"}, "range:60:80"),
    ("seq", "holding", 34, "u16", "ABCD", "seq", {}, "any"),
    ("in-f32", "input", 0, "f32", "ABCD", 88.5, {}, 88.5),
    ("in-u16", "input", 2, "u16", "ABCD", 7, {}, 7),
    ("in-i16", "input", 3, "i16", "ABCD", -7, {}, -7),
    ("in-far", "input", 60, "u16", "ABCD", 606, {}, 606),
] + [(f"coil-{i}", "coil", i, "bit", "ABCD", int(i % 3 == 0), {}, int(i % 3 == 0)) for i in range(10)] \
  + [(f"di-{i}", "discrete", i, "bit", "ABCD", int(i % 2 == 0), {}, int(i % 2 == 0)) for i in range(10)]

BIG = [(f"reg-{a}", "holding", a, "u16", "ABCD", (a * 7) & 0xFFFF, {}, (a * 7) & 0xFFFF) for a in range(100, 260)]


def template(profile: str = "meter"):
    rows = LAYOUT + (BIG if profile == "big" else [])
    pts, exp = [], {}
    for name, table, addr, typ, order, raw, extra, want in rows:
        p = {"name": name, "table": table, "address": addr, **extra}
        if table in ("holding", "input"):
            p["type"] = typ
            if order != "ABCD":
                p["order"] = order
        pts.append(p)
        exp[name] = want
    return pts, exp


class Device:
    def __init__(self, name: str, unit: int, strict: bool, profile: str, max_regs: int = 125):
        self.name, self.unit, self.strict, self.profile, self.max_regs = name, unit, strict, profile, max_regs
        self.faults = {}
        self.boot = time.time()
        self.stats = {"requests": 0, "answered": 0, "max_rate": 0, "exceptions": 0}
        self._win = []
        self.regs = {"holding": {}, "input": {}}
        self.bits = {"coil": {}, "discrete": {}}
        self.dyn = {}
        for name_, table, addr, typ, order, raw, extra, want in LAYOUT + (BIG if profile == "big" else []):
            if table in self.bits:
                self.bits[table][addr] = raw
            elif isinstance(raw, str):
                self.dyn[(table, addr)] = (raw, typ)
                for i in range({"u32": 2, "f32": 2}.get(typ, 1)):
                    self.regs[table][addr + i] = 0
            else:
                for i, w in enumerate(words(("f" if typ == "f32" else "d" if typ == "f64" else
                                             {"u16": "H", "i16": "h", "u32": "I", "i32": "i", "u64": "Q", "bit": "H"}[typ]), raw, order)):
                    self.regs[table][addr + i] = w

    def f(self, k):
        return self.faults.get(k)

    def roll(self, k):
        v = self.faults.get(k)
        return bool(v) and random.random() < float(v)

    def _dynamic(self, table):
        now = time.time()
        for (t, a), (kind, typ) in self.dyn.items():
            if t != table:
                continue
            if kind == "counter":
                ws = words("I", int(now - self.boot) & 0xFFFFFFFF)
            elif kind == "wave":
                ws = words("f", 70 + 10 * math.sin((now - T0) / 30))
            else:
                ws = [int(now * 2) & 0xFFFF]
            for i, w in enumerate(ws):
                self.regs[t][a + i] = w

    def count_rate(self):
        now = time.monotonic()
        self._win = [t for t in self._win if now - t < 1.0] + [now]
        self.stats["max_rate"] = max(self.stats["max_rate"], len(self._win))
        self.stats["requests"] += 1

    def answer(self, pdu: bytes):
        """Reply PDU, or None for no reply."""
        if self.f("offline") or self.f("silent") or self.roll("drop"):
            return None
        self.count_rate()
        if self.roll("busy"):
            self.stats["exceptions"] += 1
            return bytes([pdu[0] | 0x80, 6])
        fc = pdu[0]
        if fc not in (1, 2, 3, 4) or len(pdu) != 5:
            return bytes([(fc | 0x80) & 0xFF, 1])
        addr, count = struct.unpack(">HH", pdu[1:5])
        limit = 2000 if fc in (1, 2) else min(125, self.max_regs)
        if count < 1 or count > limit:
            self.stats["exceptions"] += 1
            return bytes([fc | 0x80, 3])
        table = {1: "coil", 2: "discrete", 3: "holding", 4: "input"}[fc]
        if fc in (1, 2):
            src = self.bits[table]
            if self.strict and any(a not in src for a in range(addr, addr + count)):
                self.stats["exceptions"] += 1
                return bytes([fc | 0x80, 2])
            out = bytearray((count + 7) // 8)
            for i in range(count):
                if src.get(addr + i):
                    out[i // 8] |= 1 << (i % 8)
            self.stats["answered"] += 1
            return bytes([fc, len(out)]) + bytes(out)
        self._dynamic(table)
        src = self.regs[table]
        if self.strict and any(a not in src for a in range(addr, addr + count)):
            self.stats["exceptions"] += 1
            return bytes([fc | 0x80, 2])
        data = b"".join(struct.pack(">H", src.get(a, 0)) for a in range(addr, addr + count))
        self.stats["answered"] += 1
        return bytes([fc, len(data)]) + data


# ---- TCP side ----------------------------------------------------------------------
def fw(args):
    subprocess.run(["iptables"] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class TcpServer:
    """A Modbus TCP device or gateway, or an RTU-over-TCP serial server (rtu=True)."""

    def __init__(self, name, ip, port, units, rtu=False, gateway=False, baud=19200):
        self.name, self.ip, self.port, self.units = name, ip, port, units  # unit -> Device
        self.rtu, self.gateway = rtu, gateway
        self.char_s = 11 / baud
        self.faults = {}
        self.conns = set()
        self.lock = asyncio.Lock()   # gateways do one request at a time
        self.inflight, self.stats = 0, {"connections": 0, "max_inflight": 0, "max_conns": 0}
        self.server = None

    async def start(self):
        self.server = await asyncio.start_server(self.client, self.ip, self.port, reuse_address=True)

    def roll(self, k):
        v = self.faults.get(k)
        return bool(v) and random.random() < float(v)

    def set_offline(self, on: bool):
        """Powered off: no packets in or out, like pulling the plug."""
        a = "-I" if on else "-D"
        fw([a, "INPUT", "-d", self.ip, "-p", "tcp", "--dport", str(self.port), "-j", "DROP"])
        fw([a, "OUTPUT", "-s", self.ip, "-p", "tcp", "--sport", str(self.port), "-j", "DROP"])
        if on:
            self.faults["offline"] = True
        else:
            self.faults.pop("offline", None)

    async def reboot(self, secs: float):
        self.set_offline(True)
        for w in list(self.conns):  # the device forgets every connection (RST is dropped too)
            w.transport.abort()
        for d in self.units.values():
            d.boot = time.time() + secs
        await asyncio.sleep(secs)
        self.set_offline(False)

    async def client(self, reader, writer):
        self.conns.add(writer)
        self.stats["connections"] += 1
        self.stats["max_conns"] = max(self.stats["max_conns"], len(self.conns))
        maxc = self.faults.get("maxconn")
        if maxc and len(self.conns) > int(maxc):
            writer.transport.abort()  # many small devices allow only one or two connections
            self.conns.discard(writer)
            return
        last_reply = None
        try:
            while True:
                if self.rtu:
                    req = await self._read_rtu(reader)
                    if req is None:
                        break
                    unit, pdu, tid = req[0], req[1], None
                else:
                    hdr = await reader.readexactly(7)
                    tid, proto, ln, unit = struct.unpack(">HHHB", hdr)
                    if proto != 0 or ln < 2 or ln > 254:
                        break
                    pdu = await reader.readexactly(ln - 1)
                asyncio.create_task(self._serve(writer, tid, unit, pdu, last_reply))
                last_reply = (tid, unit, pdu)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            self.conns.discard(writer)
            try:
                writer.close()
            except Exception:
                pass

    async def _read_rtu(self, reader):
        buf = b""
        while True:
            chunk = await reader.read(256)
            if not chunk:
                return None
            buf += chunk
            for i in range(0, max(0, len(buf) - 7)):
                f = buf[i:i + 8]
                if len(f) == 8 and f[1] in (1, 2, 3, 4) and crc16(f[:6]) == struct.unpack("<H", f[6:])[0]:
                    return f[0], f[1:6]

    async def _serve(self, writer, tid, unit, pdu, prev):
        if self.faults.get("offline") or self.faults.get("silent"):
            return
        dev = self.units.get(unit) if not (self.gateway or self.rtu) or unit in self.units else None
        if dev is None and not self.gateway and not self.rtu:
            dev = next(iter(self.units.values()))  # a plain TCP device answers any unit id
        async with self.lock if (self.gateway or self.rtu) else _null():
            self.inflight += 1
            self.stats["max_inflight"] = max(self.stats["max_inflight"], self.inflight)
            try:
                if self.gateway and (self.faults.get("gwfail") or dev is None or dev.f("offline")):
                    await asyncio.sleep(0.5 if self.faults.get("gwfail") else 1.0)
                    reply = bytes([pdu[0] | 0x80, 11])
                elif dev is None:
                    return
                else:
                    slow = float(dev.f("slow") or self.faults.get("slow") or 0)
                    reply = dev.answer(pdu)
                    serial = (8 + (len(reply) + 3 if reply else 0)) * self.char_s if (self.gateway or self.rtu) else 0.002
                    await asyncio.sleep(serial + slow)
                    if reply is None:
                        if self.gateway:  # a gateway gives up on the device and says so
                            reply = bytes([pdu[0] | 0x80, 11])
                        else:
                            return
            finally:
                self.inflight -= 1
        if writer.is_closing():
            return
        d = self.units.get(unit) or dev
        rng = lambda k: (d is not None and d.roll(k)) or self.roll(k)
        if rng("wrongunit"):
            unit = (unit + 1) & 0xFF
        if self.rtu:
            out = with_crc(bytes([unit]) + reply)
        else:
            if rng("stale") and prev and prev[0] is not None:
                old = bytes([prev[2][0], 2, 0, 0]) if prev[2][0] in (3, 4) else bytes([prev[2][0], 1, 0])
                writer.write(struct.pack(">HHHB", prev[0], 0, len(old) + 1, prev[1]) + old)
            out = struct.pack(">HHHB", tid, 0, len(reply) + 1, unit) + reply
        if rng("garbage"):
            out = bytes(random.randrange(256) for _ in range(random.randint(3, 40)))
        try:
            if rng("partial") or self.faults.get("partial") is True or (d and d.f("partial") is True):
                cut = random.randint(1, len(out) - 1)
                writer.write(out[:cut])
                await writer.drain()
                await asyncio.sleep(0.3)
                writer.write(out[cut:])
            else:
                writer.write(out)
            await writer.drain()
            if rng("close"):
                writer.close()
        except (ConnectionError, OSError):
            pass


class _null:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *a):
        return False


def _null_ctx():
    return _null()


# ---- serial side -------------------------------------------------------------------
class SerialDevice:
    """An RTU device on one port of the virtual bus."""

    def __init__(self, dev: Device, path: str, baud: int):
        self.dev = dev
        self.char_s = 11 / baud
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(self.fd)
        self.buf = b""
        asyncio.get_running_loop().add_reader(self.fd, self._rd)

    def _rd(self):
        try:
            self.buf += os.read(self.fd, 4096)
        except OSError:
            return
        b = self.buf
        i = 0
        while i + 8 <= len(b):
            if b[i] == self.dev.unit and b[i + 1] in (1, 2, 3, 4) and crc16(b[i:i + 6]) == struct.unpack("<H", b[i + 6:i + 8])[0]:
                pdu = b[i + 1:i + 6]
                self.buf = b[i + 8:]
                asyncio.create_task(self._reply(pdu))
                return
            i += 1
        self.buf = b[-16:]

    async def _reply(self, pdu):
        reply = self.dev.answer(pdu)
        if reply is None:
            return
        await asyncio.sleep(0.003 + (8 + len(reply) + 3) * self.char_s + float(self.dev.f("slow") or 0))
        out = with_crc(bytes([self.dev.unit]) + reply)
        if self.dev.roll("garbage"):
            out = bytes(random.randrange(256) for _ in range(random.randint(3, 30)))
        try:
            os.write(self.fd, out)
        except OSError:
            pass


# ---- site --------------------------------------------------------------------------
class Site:
    def __init__(self, a):
        self.a = a
        self.devices = {}   # name -> Device
        self.servers = {}   # name -> TcpServer (tcp devices by device name too)
        self.info = []
        self.bus = None
        self.dev_server = {}

    async def build(self):
        a = self.a
        ip = a.first
        rng = random.Random(a.seed)

        def next_ip():
            nonlocal ip
            v = f"{a.base}{ip}"
            ip += 1
            return v

        for i in range(1, a.tcp + 1):
            name = f"tcp-{i:02d}"
            prof = "big" if i == 1 and a.big else "tiny" if i == 2 and a.tiny else "meter"
            d = Device(name, 1, strict=(i % 2 == 1), profile=prof, max_regs=16 if prof == "tiny" else 125)
            s = TcpServer(name, next_ip(), 502, {1: d})
            await s.start()
            self.devices[name], self.servers[name], self.dev_server[name] = d, s, s
            self.info.append({"name": name, "conn": {"name": f"c-{name}", "type": "tcp", "host": s.ip, "port": 502},
                              "unit": 1, "strict": d.strict, "profile": prof})
        for g in range(1, a.gateways + 1):
            gname = f"gw{g}"
            units = {}
            gip = next_ip()
            for u in range(1, a.per_gateway + 1):
                name = f"{gname}-u{u:02d}"
                d = Device(name, u, strict=rng.random() < 0.5, profile="meter")
                units[u] = d
                self.devices[name] = d
                self.info.append({"name": name, "conn": {"name": gname, "type": "tcp", "host": gip, "port": 502},
                                  "unit": u, "strict": d.strict, "profile": "meter"})
            s = TcpServer(gname, gip, 502, units, gateway=True, baud=a.baud)
            await s.start()
            self.servers[gname] = s
            for d in units.values():
                self.dev_server[d.name] = s
        if a.rtu_over_tcp:
            sname = "rs1"
            sip = next_ip()
            units = {}
            for u in range(1, a.rtu_over_tcp + 1):
                name = f"{sname}-u{u:02d}"
                d = Device(name, u, strict=True, profile="meter")
                units[u] = d
                self.devices[name] = d
                self.info.append({"name": name, "conn": {"name": sname, "type": "rtu-over-tcp", "host": sip, "port": 4001, "baud": a.baud},
                                  "unit": u, "strict": True, "profile": "meter"})
            s = TcpServer(sname, sip, 4001, units, rtu=True, baud=a.baud)
            await s.start()
            self.servers[sname] = s
            for d in units.values():
                self.dev_server[d.name] = s
        if a.serial:
            self.bus = Bus(a.serial + 2)  # last port: a second master, for the 'master' fault
            loop = asyncio.get_running_loop()
            for i, m in enumerate(self.bus.masters):
                loop.add_reader(m, self.bus.on_read, i)
            asyncio.create_task(self.bus.noise_loop())
            for u in range(1, a.serial + 1):
                name = f"rtu-u{u:02d}"
                d = Device(name, u, strict=u % 2 == 0, profile="meter")
                self.devices[name] = d
                SerialDevice(d, self.bus.slaves[u], a.baud)
                self.info.append({"name": name, "conn": {"name": "rtu1", "type": "rtu", "serial": self.bus.slaves[0], "baud": a.baud},
                                  "unit": u, "strict": d.strict, "profile": "meter"})

    async def control(self, reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                out = {"ok": True, **(await self.cmd(json.loads(line)))}
            except Exception as e:
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()

    async def cmd(self, r):
        c = r["cmd"]
        if c == "fault":
            name, f, on = r["dev"], r["f"], r.get("on", True)
            v = r.get("v", True) if on else None
            srv = self.servers.get(name)
            dev = self.devices.get(name)
            if f == "reboot":
                if not on:
                    return {}  # a reboot ends by itself
                if srv and srv.units and (not (srv.gateway or srv.rtu) or name == srv.name):
                    asyncio.create_task(srv.reboot(float(r.get("v", 20))))
                elif dev:
                    async def rb():
                        dev.faults["offline"] = True
                        dev.boot = time.time()
                        await asyncio.sleep(float(r.get("v", 20)))
                        dev.faults.pop("offline", None)
                    asyncio.create_task(rb())
                return {}
            if f == "offline" and srv and not (srv.gateway or srv.rtu):
                srv.set_offline(bool(on))
                dev.faults.pop("offline", None)
                return {}
            if f == "offline" and srv and (srv.gateway or srv.rtu) and name == srv.name:
                srv.set_offline(bool(on))
                return {}
            target = srv.faults if (srv and name == srv.name and (srv.gateway or srv.rtu)) else dev.faults if dev else None
            if target is None:
                raise KeyError(name)
            if v is None:
                target.pop(f, None)
            else:
                target[f] = v
            # transport-level faults on a TCP device live on its server
            if srv and not (srv.gateway or srv.rtu) and f in ("maxconn", "partial", "close", "stale", "garbage", "wrongunit", "slow"):
                if v is None:
                    srv.faults.pop(f, None)
                else:
                    srv.faults[f] = v
                dev.faults.pop(f, None) if f in ("maxconn",) else None
            return {}
        if c == "master":  # another Modbus master starts (or stops) polling the RS-485 bus
            if r.get("on", True) and not getattr(self, "rogue", None):
                fd = os.open(self.bus.slaves[-1], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                tty.setraw(fd)

                async def poll():
                    try:
                        while True:
                            u = random.randint(1, max(1, self.a.serial))
                            os.write(fd, with_crc(bytes([u, 3, 0, random.choice([0, 8, 30]), 0, 2])))
                            await asyncio.sleep(0.25)
                    finally:
                        os.close(fd)
                self.rogue = asyncio.create_task(poll())
            elif not r.get("on", True) and getattr(self, "rogue", None):
                self.rogue.cancel()
                self.rogue = None
            return {}
        if c == "bus":
            if "noise" in r:
                self.bus.noise = float(r["noise"])
            if "drop" in r:
                self.bus.drop = float(r["drop"])
            if "cut" in r:
                (self.bus.cut.add if r.get("on", True) else self.bus.cut.discard)(int(r["cut"]))
            return {}
        if c == "stats":
            return {"devices": {n: d.stats for n, d in self.devices.items()},
                    "servers": {n: s.stats for n, s in self.servers.items() if s.gateway or s.rtu or n == s.name}}
        if c == "list":
            return {"devices": self.info}
        raise ValueError(c)


def _die_with_parent():
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)
    except Exception:
        pass


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="10.78.0.")
    p.add_argument("--first", type=int, default=10)
    p.add_argument("--tcp", type=int, default=6, help="Modbus TCP devices, one per IP")
    p.add_argument("--gateways", type=int, default=1)
    p.add_argument("--per-gateway", type=int, default=8)
    p.add_argument("--rtu-over-tcp", type=int, default=4, help="devices behind the RTU-over-TCP server")
    p.add_argument("--serial", type=int, default=6, help="RTU devices on the virtual RS-485 bus")
    p.add_argument("--baud", type=int, default=19200)
    p.add_argument("--big", action="store_true")
    p.add_argument("--tiny", action="store_true")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--control", default="")
    p.add_argument("--stats", default="")
    p.add_argument("--template", default="", help="print the point template for a profile and exit")
    a = p.parse_args()
    if a.template:
        pts, exp = template(a.template)
        print(json.dumps({"points": pts, "expected": exp}))
        return
    _die_with_parent()
    site = Site(a)
    await site.build()
    if a.control:
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(site.control, path=a.control)
    print(json.dumps({"ready": True, "devices": site.info, "box_serial": site.bus.slaves[0] if site.bus else None}), flush=True)
    while True:
        await asyncio.sleep(2)
        if a.stats:
            with open(a.stats + ".tmp", "w") as f:
                json.dump({n: d.stats for n, d in site.devices.items()}, f)
            os.replace(a.stats + ".tmp", a.stats)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
