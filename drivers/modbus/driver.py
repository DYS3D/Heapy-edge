"""
HEAPY Edge Modbus driver (contract v1, see contracts/driver-protocol.json).

Reads Modbus devices over:
  tcp           Modbus TCP (MBAP), including TCP-to-RTU gateways (one unit id per device)
  rtu           Modbus RTU on a serial port (RS-485 adapter)
  rtu-over-tcp  RTU frames carried raw over TCP (serial device servers)

Read-only: only function codes 1-4 (and 43/14 device id) are ever sent.
No third-party libraries: the framing, CRC and serial setup are done here, so
every fault (stale replies, noise, echo, half-open sockets) is handled in one place.

Settings (drivers.modbus.settings):
  connections: [{name, type, host, port, serial, baud, parity, stopbits,
                 timeout_ms, retries, gap_ms}]
  templates:   {name: {points: [PointDef]}}
  devices:     [{name, connection, unit, template, points: [PointDef],
                 max_regs, max_bits, max_gap, address_offset}]
  PointDef:    {name, table: holding|input|coil|discrete, address (0-based)
                 or register (40001 / 300001 style), type: u16|i16|u32|i32|f32|
                 u64|i64|f64|bit, bit (0-15, for bit in a register),
                 order: ABCD|CDAB|BADC|DCBA, scale, offset, units, description,
                 states, invalid: [raw values meaning "no data"]}
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import socket
import struct
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

VERSION = "0.1.0"
SCHEME = "modbus"

out_lock = asyncio.Lock()


def _finite(o: Any) -> Any:
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_finite(v) for v in o]
    return o


async def emit(obj: Dict[str, Any]) -> None:
    try:
        line = json.dumps(obj, default=str, separators=(",", ":"), allow_nan=False)
    except ValueError:
        line = json.dumps(_finite(obj), default=str, separators=(",", ":"), allow_nan=False)
    async with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[modbus] {msg}\n")
    sys.stderr.flush()


async def warn(msg: str) -> None:
    log(msg)
    await emit({"id": None, "event": "log", "data": {"level": "warn", "msg": msg}})


class DriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---- Modbus errors -----------------------------------------------------------
class NoAnswer(Exception):
    """No (valid) reply in time."""


class Stale(NoAnswer):
    """The device had closed our idle connection; send again on a new one."""


class BadReply(Exception):
    """Something came back that is not a valid reply."""


class LinkDown(Exception):
    """Cannot open the connection or serial port at all."""


EXC_TEXT = {1: "illegal function", 2: "illegal data address", 3: "illegal data value",
            4: "device failure", 5: "acknowledge", 6: "device busy", 8: "memory parity error",
            10: "gateway path unavailable", 11: "gateway target did not respond"}


class ModbusException(Exception):
    def __init__(self, code: int):
        super().__init__(f"exception {code} ({EXC_TEXT.get(code, 'unknown')})")
        self.code = code


class Limiter:
    def __init__(self) -> None:
        self.next_ok: Dict[str, float] = {}
        self.locks: Dict[str, asyncio.Lock] = {}

    async def wait(self, key: str, rate: float) -> None:
        if not rate or rate <= 0:
            return
        lock = self.locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            t = self.next_ok.get(key, 0.0)
            if t > now:
                await asyncio.sleep(t - now)
            self.next_ok[key] = max(now, t) + 1.0 / rate


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def with_crc(frame: bytes) -> bytes:
    return frame + struct.pack("<H", crc16(frame))


def check_pdu(pdu: bytes, fc: int, expect_bytes: int) -> bytes:
    """Validate a reply PDU (function code + data); returns the data bytes."""
    if not pdu:
        raise BadReply("empty reply")
    if pdu[0] == (fc | 0x80):
        if len(pdu) < 2:
            raise BadReply("short exception reply")
        raise ModbusException(pdu[1])
    if pdu[0] != fc:
        raise BadReply(f"reply to function {pdu[0]}, expected {fc}")
    if len(pdu) < 2 or pdu[1] != expect_bytes or len(pdu) != 2 + expect_bytes:
        raise BadReply("wrong reply length")
    return pdu[2:]


# ---- links -------------------------------------------------------------------
class Link:
    """One physical path: a TCP connection or a serial port. One request at a time."""

    def __init__(self, cfg: Dict[str, Any], defaults: Tuple[int, int, int]):
        self.cfg = cfg
        self.name = cfg["name"]
        t, r, g = defaults
        self.timeout = max(0.05, float(cfg.get("timeout_ms", t)) / 1000.0)
        self.retries = max(0, min(5, int(cfg.get("retries", r))))
        self.gap = max(0.0, float(cfg.get("gap_ms", g)) / 1000.0)
        self.lock = asyncio.Lock()
        self.last_end = 0.0
        self.down_until = 0.0
        self.down_msg = ""
        self.timeouts = 0
        self.stats = {"requests": 0, "timeouts": 0, "bad": 0, "reconnects": 0}

    def _down(self, msg: str) -> LinkDown:
        # don't hammer a dead gateway or missing port: fail fast for a few seconds
        self.down_until = time.monotonic() + min(5.0, 2 * self.timeout + 1)
        self.down_msg = msg
        return LinkDown(msg)

    async def request(self, unit: int, pdu: bytes, fc: int, expect_bytes: int) -> bytes:
        async with self.lock:
            last: Exception = NoAnswer("no answer")
            free = 1  # one resend after a stale connection doesn't count as a retry
            attempt = -1
            while attempt < self.retries:
                attempt += 1
                wait = self.last_end + self.gap - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self.stats["requests"] += 1
                try:
                    reply = await self._xfer(unit, pdu, fc, expect_bytes)
                    self.timeouts = 0
                    return check_pdu(reply, fc, expect_bytes)
                except ModbusException as e:
                    self.timeouts = 0
                    if e.code in (5, 6):  # busy / working on it: wait a little and ask again
                        last = e
                        await asyncio.sleep(0.2 * (attempt + 1))
                        continue
                    if e.code in (10, 11):  # gateway could not reach the device this time: ask again
                        self.stats["timeouts"] += 1
                        last = NoAnswer(str(e))
                        continue
                    raise
                except Stale as e:
                    last = e
                    if free:
                        free -= 1
                        attempt -= 1
                except NoAnswer as e:
                    self.stats["timeouts"] += 1
                    self.timeouts += 1
                    last = e
                    self.on_timeout()
                except BadReply as e:
                    self.stats["bad"] += 1
                    last = e
                    self.on_bad()
                finally:
                    self.last_end = time.monotonic()
            if isinstance(last, ModbusException):
                raise last
            raise NoAnswer(str(last))

    def on_timeout(self) -> None:
        pass

    def on_bad(self) -> None:
        pass

    async def close(self) -> None:
        pass


class TcpLink(Link):
    """Modbus TCP (MBAP header). Replies are matched by transaction id, so a late
    reply to an earlier request is recognised and thrown away."""

    def __init__(self, cfg, defaults):
        super().__init__(cfg, defaults)
        self.host = str(cfg["host"])
        self.port = int(cfg.get("port", 502))
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.tid = 0

    async def _connect(self) -> None:
        if self.writer:
            return
        if time.monotonic() < self.down_until:
            raise LinkDown(self.down_msg)
        try:
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port, limit=65536), max(self.timeout, 2.0))
        except (OSError, asyncio.TimeoutError) as e:
            self.reader = self.writer = None
            raise self._down(f"cannot connect to {self.host}:{self.port} ({type(e).__name__}: {e})")
        self.stats["reconnects"] += 1
        sock = self.writer.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            except OSError:
                pass

    def _drop(self) -> None:
        if self.writer:
            try:
                self.writer.transport.abort()
            except Exception:
                pass
        self.reader = self.writer = None

    def on_timeout(self) -> None:
        # a device that rebooted leaves our socket half-open: every write "works"
        # and nothing ever comes back. After two misses in a row, start fresh.
        if self.timeouts >= 2:
            self._drop()

    def on_bad(self) -> None:
        self._drop()  # the byte stream can't be trusted any more

    async def _xfer(self, unit, pdu, fc, expect_bytes):
        fresh = self.writer is None
        await self._connect()
        self.tid = (self.tid + 1) & 0xFFFF
        tid = self.tid
        adu = struct.pack(">HHHB", tid, 0, len(pdu) + 1, unit) + pdu
        for again in (False, True):
            try:
                self.writer.write(adu)
                await self.writer.drain()
                break
            except (OSError, RuntimeError, AttributeError):
                self._drop()
                if again or fresh:
                    raise NoAnswer("connection lost")
                await self._connect()  # an idle connection the device had closed
                fresh = True
        deadline = time.monotonic() + self.timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise NoAnswer("no answer")
            try:
                hdr = await asyncio.wait_for(self.reader.readexactly(7), remain)
            except asyncio.TimeoutError:
                raise NoAnswer("no answer")  # nothing consumed: the stream is still in step
            except (asyncio.IncompleteReadError, OSError, AttributeError):
                self._drop()
                if not fresh:
                    raise Stale("connection closed by device")
                raise NoAnswer("connection closed by device")
            t, proto, ln, u = struct.unpack(">HHHB", hdr)
            if proto != 0 or ln < 2 or ln > 254:
                raise BadReply("not a Modbus TCP reply")
            try:
                body = await asyncio.wait_for(self.reader.readexactly(ln - 1), max(remain, 0.5))
            except (asyncio.TimeoutError, asyncio.IncompleteReadError, OSError):
                self._drop()  # half a frame: out of step
                raise NoAnswer("reply cut off")
            if t != tid:
                continue  # late reply to an earlier request
            if u != unit and unit != 0 and u != 0:
                continue
            return body

    async def close(self) -> None:
        self._drop()


BAUDS = {1200: "B1200", 2400: "B2400", 4800: "B4800", 9600: "B9600", 19200: "B19200",
         38400: "B38400", 57600: "B57600", 115200: "B115200"}


class RtuBase(Link):
    """RTU framing. Incoming bytes collect in a buffer; a reply is any slice that
    has the right unit, function, length and CRC. Noise, our own echo on 2-wire
    adapters and leftovers of earlier replies are skipped that way."""

    def __init__(self, cfg, defaults):
        super().__init__(cfg, defaults)
        self.buf = bytearray()
        self.data_evt = asyncio.Event()
        self.baud = int(cfg.get("baud", 9600))
        bits = 11  # start + 8 data + parity/stop + stop
        self.char_s = bits / self.baud
        self.silence = 0.00175 if self.baud > 19200 else 3.5 * self.char_s

    def _feed(self, data: bytes) -> None:
        self.buf += data
        if len(self.buf) > 8192:
            del self.buf[:-4096]
        self.data_evt.set()

    def _find(self, unit: int, fc: int, expect_bytes: int) -> Optional[bytes]:
        b = self.buf
        n = len(b)
        for i in range(0, max(0, n - 4)):
            if b[i] != unit:
                continue
            f = b[i + 1]
            if f == (fc | 0x80):
                ln = 5
            elif f == fc and b[i + 2] == expect_bytes:
                ln = 5 + expect_bytes
            else:
                continue
            if i + ln > n:
                continue
            frame = bytes(b[i:i + ln])
            if crc16(frame[:-2]) == struct.unpack("<H", frame[-2:])[0]:
                del b[:i + ln]
                return frame[1:-2]
        return None

    async def _xfer(self, unit, pdu, fc, expect_bytes):
        await self._open()
        wait = self.last_end + self.silence - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self.buf.clear()
        frame = with_crc(bytes([unit]) + pdu)
        await self._write(frame)
        # the port returns at once; the frame is still going out on the wire
        deadline = time.monotonic() + len(frame) * self.char_s + self.timeout
        while True:
            got = self._find(unit, fc, expect_bytes)
            if got is not None:
                return got
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise NoAnswer("no answer" if not self.buf else "no valid reply (noise or damaged frames)")
            self.data_evt.clear()
            try:
                await asyncio.wait_for(self.data_evt.wait(), remain)
            except asyncio.TimeoutError:
                pass
            if self._lost():
                raise NoAnswer("connection lost")


class SerialLink(RtuBase):
    def __init__(self, cfg, defaults):
        super().__init__(cfg, defaults)
        self.path = str(cfg["serial"])
        self.fd: Optional[int] = None
        self.dead = False

    async def _open(self) -> None:
        if self.fd is not None and not self.dead:
            return
        self._shut()
        if time.monotonic() < self.down_until:
            raise LinkDown(self.down_msg)
        import termios
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as e:
            raise self._down(f"cannot open {self.path} ({e.strerror})")
        try:
            a = termios.tcgetattr(fd)
            speed = getattr(termios, BAUDS.get(self.baud, "B9600"))
            parity = str(self.cfg.get("parity", "N")).upper()[:1]
            a[0] = termios.IGNBRK | (termios.INPCK if parity in "EO" and parity else 0)  # iflag
            a[1] = 0  # oflag
            c = termios.CS8 | termios.CREAD | termios.CLOCAL
            if parity == "E":
                c |= termios.PARENB
            elif parity == "O":
                c |= termios.PARENB | termios.PARODD
            if int(self.cfg.get("stopbits", 1)) == 2:
                c |= termios.CSTOPB
            a[2] = c
            a[3] = 0  # lflag: raw
            a[4] = a[5] = speed
            a[6][termios.VMIN] = 0
            a[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSANOW, a)
            termios.tcflush(fd, termios.TCIOFLUSH)
        except Exception as e:
            os.close(fd)
            raise self._down(f"cannot set up {self.path} ({e})")
        self.fd, self.dead = fd, False
        self.stats["reconnects"] += 1
        asyncio.get_running_loop().add_reader(fd, self._readable)

    def _readable(self) -> None:
        try:
            data = os.read(self.fd, 4096)
        except BlockingIOError:
            return
        except OSError:
            self.dead = True  # adapter unplugged
            self.data_evt.set()
            try:
                asyncio.get_running_loop().remove_reader(self.fd)
            except Exception:
                pass
            return
        if data:
            self._feed(data)

    def _lost(self) -> bool:
        return self.dead

    async def _write(self, frame: bytes) -> None:
        view = memoryview(frame)
        end = time.monotonic() + 1.0
        while view:
            try:
                n = os.write(self.fd, view)
                view = view[n:]
            except BlockingIOError:
                if time.monotonic() > end:
                    raise NoAnswer("serial port not accepting data")
                await asyncio.sleep(0.005)
            except OSError as e:
                self.dead = True
                raise NoAnswer(f"serial port error ({e.strerror})")

    def _shut(self) -> None:
        if self.fd is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.fd)
            except Exception:
                pass
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.fd = None

    async def close(self) -> None:
        self._shut()


class RtuTcpLink(RtuBase):
    def __init__(self, cfg, defaults):
        super().__init__(cfg, defaults)
        self.host = str(cfg["host"])
        self.port = int(cfg.get("port", 4001))
        self.writer: Optional[asyncio.StreamWriter] = None
        self.pump: Optional[asyncio.Task] = None
        self.silence = 0.0 if "baud" not in cfg else self.silence
        if "baud" not in cfg:
            self.char_s = 0.0

    async def _open(self) -> None:
        if self.writer and self.pump and not self.pump.done():
            return
        await self.close()
        if time.monotonic() < self.down_until:
            raise LinkDown(self.down_msg)
        try:
            reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), max(self.timeout, 2.0))
        except (OSError, asyncio.TimeoutError) as e:
            self.writer = None
            raise self._down(f"cannot connect to {self.host}:{self.port} ({type(e).__name__})")
        self.stats["reconnects"] += 1

        async def pump():
            try:
                while True:
                    d = await reader.read(4096)
                    if not d:
                        break
                    self._feed(d)
            except (OSError, asyncio.CancelledError):
                pass
            self.data_evt.set()
        self.pump = asyncio.create_task(pump())

    def _lost(self) -> bool:
        return self.pump is None or self.pump.done()

    def on_timeout(self) -> None:
        if self.timeouts >= 2 and self.writer:
            self.writer.transport.abort()

    async def _write(self, frame: bytes) -> None:
        try:
            self.writer.write(frame)
            await self.writer.drain()
        except (OSError, RuntimeError):
            await self.close()
            raise NoAnswer("connection lost")

    async def close(self) -> None:
        if self.writer:
            try:
                self.writer.transport.abort()
            except Exception:
                pass
        if self.pump:
            self.pump.cancel()
        self.writer, self.pump = None, None


LINK_TYPES = {"tcp": (TcpLink, (3000, 2, 0)), "rtu": (SerialLink, (1000, 2, 20)),
              "rtu-over-tcp": (RtuTcpLink, (2000, 2, 20))}


# ---- point definitions -------------------------------------------------------
TABLES = {"coil": 1, "discrete": 2, "holding": 3, "input": 4}
TABLE_ALIASES = {"coils": "coil", "discrete-input": "discrete", "discrete_input": "discrete", "di": "discrete",
                 "holding-register": "holding", "hr": "holding", "input-register": "input", "ir": "input"}
TYPES = {"u16": (1, "H"), "i16": (1, "h"), "u32": (2, "I"), "i32": (2, "i"), "f32": (2, "f"),
         "u64": (4, "Q"), "i64": (4, "q"), "f64": (4, "d"), "bit": (1, None)}
ORDERS = {"ABCD": (False, False), "CDAB": (True, False), "BADC": (False, True), "DCBA": (True, True),
          "AB": (False, False), "BA": (False, True)}
NAME_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def parse_point(d: Dict[str, Any], offset: int) -> Dict[str, Any]:
    p = dict(d)
    if "register" in p and "address" not in p:
        r = int(p["register"])
        for base, table in ((400001, "holding"), (300001, "input"), (100001, "discrete"),
                            (40001, "holding"), (30001, "input"), (10001, "discrete")):
            if r >= base and r < base + (65536 if base >= 100001 else 9999):
                p["table"], p["address"] = table, r - base
                break
        else:
            raise ValueError(f"register {r} is not in 1xxxx/3xxxx/4xxxx form")
    table = str(p.get("table", "holding")).lower()
    table = TABLE_ALIASES.get(table, table)
    if table not in TABLES:
        raise ValueError(f"unknown table {p.get('table')}")
    addr = int(p["address"]) + int(offset)
    typ = "bit" if table in ("coil", "discrete") else str(p.get("type", "u16")).lower()
    if typ not in TYPES:
        raise ValueError(f"unknown type {p.get('type')}")
    width = TYPES[typ][0]
    if addr < 0 or addr + width > 65536:
        raise ValueError(f"address {addr} out of range")
    order = str(p.get("order", "ABCD")).upper()
    if order not in ORDERS:
        raise ValueError(f"unknown order {p.get('order')}")
    bit = p.get("bit")
    if typ == "bit" and table in ("holding", "input"):
        bit = int(bit or 0)
        if not 0 <= bit <= 15:
            raise ValueError("bit must be 0-15")
    q = f"type={typ}"
    if width > 1 and order != "ABCD":
        q += f"&order={order}"
    if typ == "bit" and table in ("holding", "input"):
        q += f"&bit={bit}"
    name = str(p.get("name") or f"{table}:{addr}")
    return {"table": table, "address": addr, "type": typ, "width": width, "order": order, "bit": bit,
            "scale": float(p.get("scale", 1)), "offset": float(p.get("offset", 0)),
            "name": name, "units": p.get("units"), "description": str(p.get("description") or ""),
            "states": p.get("states"), "invalid": [int(x) for x in p.get("invalid") or []],
            "suffix": f"{table}:{addr}?{q}"}


def key_to_def(key: str) -> Dict[str, Any]:
    """Rebuild a point definition from its key (used when the settings no longer list it)."""
    obj = key.split("://", 1)[1].split("/", 1)[1]
    loc, _, qs = obj.partition("?")
    table, addr = loc.split(":")
    q = dict(x.split("=", 1) for x in qs.split("&") if "=" in x)
    return parse_point({"table": table, "address": int(addr), "type": q.get("type", "u16"),
                        "order": q.get("order", "ABCD"), "bit": q.get("bit")}, 0)


def decode(d: Dict[str, Any], regs: bytes) -> Tuple[Optional[float], Optional[str]]:
    typ = d["type"]
    if typ == "bit" and d["table"] in ("holding", "input"):
        raw = (struct.unpack(">H", regs[:2])[0] >> d["bit"]) & 1
        return raw, None
    width, code = TYPES[typ]
    words = [regs[i:i + 2] for i in range(0, width * 2, 2)]
    wswap, bswap = ORDERS[d["order"]]
    if wswap:
        words.reverse()
    if bswap:
        words = [w[::-1] for w in words]
    raw = struct.unpack(">" + code, b"".join(words))[0]
    if d["invalid"] and not isinstance(raw, float) and raw in d["invalid"]:
        return None, "no data (device reports not available)"
    if isinstance(raw, float) and not math.isfinite(raw):
        return None, "invalid value (NaN)"
    if not isinstance(raw, float) and d["scale"] == 1 and d["offset"] == 0:
        return raw, None  # whole numbers stay exact (64-bit counters)
    v = raw * d["scale"] + d["offset"]
    if not math.isfinite(v):
        return None, "invalid value"
    if typ == "f32" or isinstance(v, float):
        v = float(format(v, ".7g" if typ == "f32" else ".12g"))
        if v.is_integer() and abs(v) < 2 ** 53:
            v = int(v)
    return v, None


def plan_blocks(defs: List[Dict[str, Any]], max_regs: int, max_bits: int, max_gap: int,
                alone: set) -> List[Tuple[str, int, int, List[Dict[str, Any]]]]:
    """Group points into as few reads as possible: (table, start, count, points)."""
    blocks = []
    by_table: Dict[str, List[Dict[str, Any]]] = {}
    for d in defs:
        by_table.setdefault(d["table"], []).append(d)
    for table, ds in by_table.items():
        bits = table in ("coil", "discrete")
        limit = max_bits if bits else max_regs
        gap = max_gap * (16 if bits else 1)
        ds.sort(key=lambda d: (d["address"], d["width"]))
        cur = None
        for d in ds:
            a, e = d["address"], d["address"] + d["width"]
            if (table, d["address"]) in alone:
                blocks.append((table, a, d["width"], [d]))
                continue
            if cur and a - cur[2] <= gap and max(e, cur[2]) - cur[1] <= limit:
                cur[2] = max(cur[2], e)
                cur[3].append(d)
            else:
                if cur:
                    blocks.append((cur[0], cur[1], cur[2] - cur[1], cur[3]))
                cur = [table, a, e, [d]]
        if cur:
            blocks.append((cur[0], cur[1], cur[2] - cur[1], cur[3]))
    return blocks


# ---- driver ------------------------------------------------------------------
class Driver:
    def __init__(self) -> None:
        self.settings: Dict[str, Any] = {}
        self.links: Dict[str, Link] = {}
        self.devices: Dict[str, Dict[str, Any]] = {}   # key -> device config
        self.limiter = Limiter()
        self.strict: Dict[str, float] = {}             # device key -> until: no gaps inside reads
        self.alone: Dict[str, Dict[Tuple[str, int], float]] = {}  # device key -> points read on their own
        self.warnings: List[str] = []

    async def op_hello(self, req):
        return {"driver": "modbus", "version": VERSION, "scheme": SCHEME,
                "capabilities": ["discover", "browse", "read"]}

    async def op_configure(self, req):
        s = req.get("settings") or {}
        for l in self.links.values():
            await l.close()
        self.links, self.devices, self.warnings = {}, {}, []
        self.settings = s
        w = self.warnings
        for c in s.get("connections") or []:
            try:
                name = str(c["name"])
                typ = str(c.get("type", "tcp"))
                if typ not in LINK_TYPES:
                    raise ValueError(f"unknown type {typ}")
                if name in self.links:
                    raise ValueError("name used twice")
                cls, dflt = LINK_TYPES[typ]
                self.links[name] = cls(c, dflt)
            except Exception as e:
                w.append(f"connection {c.get('name', '?')}: {e}")
        templates = s.get("templates") or {}
        for dv in s.get("devices") or []:
            try:
                name = str(dv["name"])
                if not NAME_OK.match(name):
                    raise ValueError("name may only use letters, digits, . _ -")
                key = f"{SCHEME}://{name}"
                if key in self.devices:
                    raise ValueError("name used twice")
                conn = str(dv["connection"])
                if conn not in self.links:
                    raise ValueError(f"unknown connection {conn}")
                unit = int(dv.get("unit", 1))
                if not 0 <= unit <= 255:
                    raise ValueError("unit must be 0-255")
                raw = []
                if dv.get("template"):
                    t = templates.get(dv["template"])
                    if t is None:
                        raise ValueError(f"unknown template {dv['template']}")
                    raw += t.get("points") or []
                raw += dv.get("points") or []
                off = int(dv.get("address_offset", 0))
                pts: Dict[str, Dict[str, Any]] = {}
                for p in raw:
                    try:
                        d = parse_point(p, off)
                    except Exception as e:
                        w.append(f"{name} point {p.get('name', '?')}: {e}")
                        continue
                    pk = f"{key}/{d['suffix']}"
                    d["key"] = pk
                    pts[pk] = d  # a device point overrides the template point at the same address
                link = self.links[conn]
                self.devices[key] = {
                    "key": key, "name": name, "conn": conn, "unit": unit, "points": pts,
                    "max_regs": max(1, min(125, int(dv.get("max_regs", 100)))),
                    "max_bits": max(1, min(2000, int(dv.get("max_bits", 800)))),
                    "max_gap": max(0, min(100, int(dv.get("max_gap", 8)))),
                    "route": f"{link.cfg.get('type', 'tcp')}:{link.cfg.get('host') or link.cfg.get('serial')}"
                             f"{':' + str(link.cfg.get('port', 502)) if link.cfg.get('host') else ''} unit {unit}",
                    "vendor": dv.get("vendor"), "model": dv.get("model") or dv.get("template"),
                }
            except Exception as e:
                w.append(f"device {dv.get('name', '?')}: {e}")
        for m in w:
            log(m)
        return {"ok": True, "connections": len(self.links), "devices": len(self.devices), "warnings": w}

    def _dev(self, dev: Dict[str, Any]) -> Dict[str, Any]:
        d = self.devices.get(dev["key"])
        if not d:
            raise DriverError("bad_request", f"{dev['key']} is not in the Modbus settings any more")
        return d

    async def op_discover(self, req):
        rid = req["id"]
        n = 0
        for d in self.devices.values():
            link = self.links[d["conn"]]
            await emit({"id": rid, "event": "device", "data": {
                "key": d["key"], "route": d["route"], "name": d["name"], "vendor": d["vendor"], "model": d["model"],
                "meta": {"lane": f"link:{d['conn']}", "lane_max": 1, "unit": d["unit"], "connection": d["conn"],
                         "type": link.cfg.get("type", "tcp")}}})
            n += 1
        out: Dict[str, Any] = {"devices": n, "warnings": self.warnings}
        # optional: which unit ids answer on a connection (helps set up a new trunk)
        scans = (req.get("targets") or {}).get("scan_units") or []
        if scans:
            out["units_found"] = {}
            for sc in scans:
                link = self.links.get(sc.get("connection"))
                if not link:
                    continue
                found = []
                for u in range(int(sc.get("from", 1)), int(sc.get("to", 247)) + 1):
                    try:
                        await link.request(u, struct.pack(">BHH", 3, 0, 1), 3, 2)
                        found.append(u)
                    except ModbusException:
                        found.append(u)  # an error reply still means something lives there
                    except (NoAnswer, BadReply, LinkDown):
                        pass
                    await emit({"id": rid, "event": "progress", "data": {"connection": link.name, "unit": u}})
                out["units_found"][link.name] = found
        return out

    async def op_browse(self, req):
        d = self._dev(req["device"])
        rid = req["id"]
        for p in d["points"].values():
            kind = "binary" if p["type"] == "bit" else "number"
            pt = {"key": p["key"], "name": p["name"], "description": p["description"], "kind": kind,
                  "units": p["units"], "cov": False}
            if kind == "binary":
                pt["states"] = p["states"] or ["off", "on"]
            await emit({"id": rid, "event": "point", "data": pt})
        return {"points": len(d["points"])}

    async def _read_block(self, link: Link, d, table, start, count, rate) -> bytes:
        await self.limiter.wait(d["key"], rate)
        fc = TABLES[table]
        nbytes = (count + 7) // 8 if fc in (1, 2) else count * 2
        return await link.request(d["unit"], struct.pack(">BHH", fc, start, count), fc, nbytes)

    async def op_read(self, req):
        d = self._dev(req["device"])
        link = self.links[d["conn"]]
        rate = float(req.get("rate", 5))
        now_m = time.monotonic()
        defs = []
        for pk in req["points"]:
            p = d["points"].get(pk)
            if p is None:
                try:
                    p = dict(key_to_def(pk), key=pk)
                except Exception:
                    p = {"key": pk, "bad": True}
            defs.append(p)
        good = [p for p in defs if not p.get("bad")]
        alone = {k for k, t in self.alone.get(d["key"], {}).items() if t > now_m}
        strict = self.strict.get(d["key"], 0) > now_m
        blocks = plan_blocks(good, d["max_regs"], d["max_bits"], 0 if strict else d["max_gap"], alone)
        results: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
        answered, misses, dead = False, 0, None
        queue = list(blocks)
        while queue:
            table, start, count, pts = queue.pop(0)
            if dead:
                for p in pts:
                    results[p["key"]] = (None, "no answer")
                continue
            try:
                data = await self._read_block(link, d, table, start, count, rate)
                answered, misses = True, 0
                for p in pts:
                    off = p["address"] - start
                    if table in ("coil", "discrete"):
                        results[p["key"]] = ((data[off // 8] >> (off % 8)) & 1, None)
                    else:
                        results[p["key"]] = decode(p, data[off * 2:(off + p["width"]) * 2])
            except ModbusException as e:
                answered, misses = True, 0
                if len(pts) == 1 and count == pts[0]["width"]:
                    results[pts[0]["key"]] = (None, str(e), e.code in (4, 5, 6))  # busy / failure: may pass
                    continue
                # something in this range is refused: read without gaps, then point by point
                self.strict[d["key"]] = now_m + 3600
                covered = set()
                for p in pts:
                    covered.update(range(p["address"], p["address"] + p["width"]))
                sub = plan_blocks(pts, d["max_regs"], d["max_bits"], 0, alone) if len(covered) < count else []
                if len(sub) <= 1:
                    sub = [(table, p["address"], p["width"], [p]) for p in pts]
                    for p in pts:
                        self.alone.setdefault(d["key"], {})[(table, p["address"])] = now_m + 3600
                queue[:0] = sub
            except (NoAnswer, BadReply) as e:
                misses += 1
                if not answered or misses >= 2:
                    dead = str(e)
                for p in pts:
                    results[p["key"]] = (None, "no answer")
            except LinkDown as e:
                raise DriverError("unreachable", str(e))
        if not answered:
            raise DriverError("timeout", f"{d['name']}: {dead or 'no answer'}")
        t = int(time.time() * 1000)
        values, dev_errs = [], 0
        for p in defs:
            if p.get("bad"):
                v, err = None, "not a valid Modbus point key"
            else:
                v, err, *again = results.get(p["key"], (None, "no answer"))
            s = {"point": p["key"], "t": t, "v": v}
            if err:
                s["error"] = err
                if again and again[0]:
                    s["retry"] = True
                if "device failure" in err:
                    dev_errs += 1
            values.append(s)
        if values and dev_errs == len(values):
            raise DriverError("rejected", f"{d['name']} reports a device failure on every read")
        return {"values": values}

    async def op_stats(self, req):
        return {name: l.stats for name, l in self.links.items()}

    async def op_shutdown(self, req):
        for l in self.links.values():
            await l.close()
        asyncio.get_running_loop().call_later(0.1, lambda: os._exit(0))
        return {"ok": True}

    async def handle(self, req):
        rid = req.get("id")
        fn = getattr(self, "op_" + str(req.get("op")), None)
        try:
            if not fn:
                raise DriverError("bad_request", f"unknown op {req.get('op')}")
            result = await fn(req)
            await emit({"id": rid, "ok": True, "result": result})
        except DriverError as e:
            await emit({"id": rid, "ok": False, "error": {"code": e.code, "message": str(e)}})
        except Exception as e:  # keep the driver alive
            log(f"error in {req.get('op')}: {e!r}")
            await emit({"id": rid, "ok": False, "error": {"code": "internal", "message": repr(e)}})


async def main():
    drv = Driver()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=16 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    tasks = set()
    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            await emit({"id": None, "event": "log", "data": {"level": "error", "msg": "bad JSON"}})
            continue
        t = asyncio.create_task(drv.handle(req))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())
