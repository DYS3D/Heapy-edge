"""
HEAPY Edge BACnet MS/TP driver (contract v1).

For MS/TP trunks with no BACnet router to reach them through. The box joins the
RS-485 trunk itself: an MS/TP-to-IP router (bacnet-stack router-mstp, GPL-2.0+
with the GCC linking exception, run as a separate program) links the serial
port to a private network inside the box, and the BACnet/IP driver reads the
trunk's devices through it. Read-only, like every HEAPY Edge driver.

Before joining, the driver listens to the trunk: it finds the baud rate and
the MAC addresses already in use, so the box never takes an address that is
taken (a duplicate MAC would disturb the whole trunk).

settings: {serial: "/dev/ttyUSB0", baud: "auto"|38400, mac: "auto"|n,
           max_master: 127, max_info_frames: 1, trunk_net: 3001,
           router: "/opt/heapy-edge/bin/router-mstp", link: "10.255.77"}
"""

from __future__ import annotations

import asyncio
import ctypes
import importlib.util
import signal
import os
import select
import shutil
import subprocess
import sys
import termios
import time
from typing import Dict, Optional, Set

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("bacnet_ip_driver", os.path.join(HERE, "..", "bacnet-ip", "driver.py"))
bip = importlib.util.module_from_spec(_spec)
sys.modules["bacnet_ip_driver"] = bip
_spec.loader.exec_module(bip)

VERSION = "0.1.0"
BAUDS = {9600: termios.B9600, 19200: termios.B19200, 38400: termios.B38400,
         57600: termios.B57600, 115200: termios.B115200}


def crc8_header(data: bytes) -> int:
    """MS/TP header CRC (ANSI/ASHRAE 135 Annex G.1)."""
    crc = 0xFF
    for b in data:
        t = crc ^ b
        t = t ^ (t << 1) ^ (t << 2) ^ (t << 3) ^ (t << 4) ^ (t << 5) ^ (t << 6) ^ (t << 7)
        crc = (t & 0xFE) ^ ((t >> 8) & 1)
    return crc & 0xFF


def find_frames(buf: bytes):
    """Valid MS/TP frame headers in raw bytes: yields (frame_type, dest, src)."""
    i = 0
    while i + 8 <= len(buf):
        if buf[i] == 0x55 and buf[i + 1] == 0xFF:
            hdr = buf[i + 2:i + 7]
            if crc8_header(hdr) ^ 0xFF == buf[i + 7]:
                yield hdr[0], hdr[1], hdr[2]
                i += 8
                continue
        i += 1


def listen(port: str, baud: int, secs: float) -> bytes:
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attrs = termios.tcgetattr(fd)
        attrs[0] = 0
        attrs[1] = 0
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0
        attrs[4] = attrs[5] = BAUDS[baud]
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIFLUSH)
        end, out = time.monotonic() + secs, b""
        while time.monotonic() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    out += os.read(fd, 4096)
                except BlockingIOError:
                    pass
        return out
    finally:
        os.close(fd)


def survey(port: str, baud, secs: float = 4.0):
    """(baud, macs_in_use, frames_seen) by listening only; never transmits."""
    tries = [int(baud)] if baud not in (None, "auto") else [38400, 76800, 19200, 9600, 115200, 57600]
    best = (tries[0], set(), 0)
    for b in tries:
        if b not in BAUDS:
            continue
        frames = list(find_frames(listen(port, b, secs)))
        macs: Set[int] = set()
        for ftype, dest, src in frames:
            macs.add(src)
            if ftype == 0:  # a token is passed to a station that exists
                macs.add(dest)
        macs.discard(255)
        if len(frames) > best[2]:
            best = (b, macs, len(frames))
        if len(frames) >= 20:
            break
    return best


def _die_with_parent():
    # the router must never outlive the driver: two routers on one port would
    # both use the box's MAC address on the trunk
    ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)


class MstpDriver(bip.Driver):
    def __init__(self):
        super().__init__()
        self.router: Optional[subprocess.Popen] = None
        self.ns = None
        self.plan: Dict = {}
        self.watch: Optional[asyncio.Task] = None
        self.avoid: Set[int] = set()  # addresses another station turned out to use
        self.clash: Optional[int] = None
        self.rejoining = False
        self.settings_in: Dict = {}

    async def op_hello(self, req):
        r = await super().op_hello(req)
        r.update(driver="bacnet-mstp", version=VERSION)
        return r

    def _sh(self, *cmd):
        return subprocess.run(cmd, check=True, capture_output=True, text=True)

    def _link_up(self, name: str, pfx: str):
        """Private network inside the box: router in its own namespace, driver on the host side."""
        host, peer = f"he-{name}"[:15], f"hr-{name}"[:15]
        # a router left over from a crash still holds the serial port: stop it first
        pids = subprocess.run(["ip", "netns", "pids", self.ns], capture_output=True, text=True).stdout.split()
        for pid in pids:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except (ProcessLookupError, ValueError):
                pass
        subprocess.run(["ip", "netns", "del", self.ns], capture_output=True)
        subprocess.run(["ip", "link", "del", host], capture_output=True)
        # links left by a driver that was killed while its port had another name
        # (USB adapter re-plugged as ttyUSB1): nothing runs in them any more
        for ns in subprocess.run(["ip", "netns", "list"], capture_output=True, text=True).stdout.split("\n"):
            ns = ns.split(" ")[0]
            if ns.startswith("heapy-mstp-") and ns != self.ns and \
                    not subprocess.run(["ip", "netns", "pids", ns], capture_output=True, text=True).stdout.split():
                subprocess.run(["ip", "netns", "del", ns], capture_output=True)
        select.select([], [], [], 0.2)  # a short pause (time.sleep can fail under LD_PRELOAD clock shims)
        # the private network must not clash with anything else on the box (site LAN, another MS/TP port)
        net = pfx + "."
        for line in subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True).stdout.splitlines():
            f = line.split()
            if len(f) > 3 and f[3].startswith(net):
                raise bip.DriverError("bad_request", f"the box's private MS/TP network {pfx}.0/24 is already used by {f[1]}; "
                                      f"set a different 'link' in the MS/TP settings")
        self._sh("ip", "netns", "add", self.ns)
        self._sh("ip", "link", "add", host, "type", "veth", "peer", "name", peer)
        self._sh("ip", "link", "set", peer, "netns", self.ns)
        self._sh("ip", "addr", "add", f"{pfx}.1/24", "brd", f"{pfx}.255", "dev", host)
        self._sh("ip", "link", "set", host, "up")
        self._sh("ip", "netns", "exec", self.ns, "ip", "addr", "add", f"{pfx}.2/24", "brd", f"{pfx}.255", "dev", peer)
        self._sh("ip", "netns", "exec", self.ns, "ip", "link", "set", peer, "up")
        self._sh("ip", "netns", "exec", self.ns, "ip", "link", "set", "lo", "up")
        return peer

    def _start_router(self):
        p = self.plan
        env = dict(os.environ, BACNET_IFACE=p["peer"], BACNET_MSTP_IFACE=p["serial"], BACNET_MSTP_MAC=str(p["mac"]),
                   BACNET_MSTP_BAUD=str(p["baud"]), BACNET_MAX_MASTER=str(p["max_master"]),
                   BACNET_MAX_INFO_FRAMES=str(p["max_info_frames"]), BACNET_IP_NET="1", BACNET_MSTP_NET=str(p["trunk_net"]))
        self.router = subprocess.Popen(["ip", "netns", "exec", self.ns, p["router"]], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=_die_with_parent)
        bip.log(f"MS/TP router on {p['serial']} at {p['baud']} baud, MAC {p['mac']}, network {p['trunk_net']}")

    async def _watch_router(self):
        """Restart the router if it stops (e.g. USB adapter unplugged and back)."""
        backoff = 2
        while True:
            await asyncio.sleep(2)
            if self.router and self.router.poll() is not None:
                bip.log(f"MS/TP router stopped (code {self.router.returncode}); restarting in {backoff}s")
                await bip.emit({"id": None, "event": "log", "data": {"level": "warn", "msg": "MS/TP router restarted"}})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
                if os.path.exists(self.plan["serial"]):
                    self._start_router()
            elif self.router:
                backoff = 2

    async def op_configure(self, req):
        s = req.get("settings") or {}
        self.settings_in = s
        if self.router and self.router.poll() is None:
            self.router.terminate()
            try:
                self.router.wait(3)
            except subprocess.TimeoutExpired:
                self.router.kill()
            self.router = None
            await asyncio.sleep(1)  # let the other stations notice the address went quiet
        serial = s.get("serial", "/dev/ttyUSB0")
        if not os.path.exists(serial):
            raise bip.DriverError("unreachable", f"serial port {serial} not found")
        router = s.get("router") or shutil.which("router-mstp") or os.path.join(HERE, "..", "..", "bin", "router-mstp")
        if not os.path.exists(router):
            raise bip.DriverError("bad_request", "router-mstp program not found")
        # listen first: baud rate and MACs in use, without sending anything
        loop = asyncio.get_running_loop()
        listen_s = float(s.get("listen_s", 4))
        baud, macs, frames = await loop.run_in_executor(None, survey, serial, s.get("baud", "auto"), listen_s)
        # A silent trunk is unusual (controllers pass the token all day). Before treating
        # it as empty, listen a good while longer: joining on an address that is in use
        # would break the trunk for everyone, so a slow start is the safer mistake.
        # Also a trunk that is still sorting itself out (few frames, or a single station
        # polling for masters after the ring broke) is not a picture to trust yet.
        quiet = 0
        while (frames < 200 or len(macs) < 2) and quiet < int(s.get("quiet_rounds", 6)):
            quiet += 1
            bip.log(f"{serial}: only {frames} frames from {len(macs)} stations; listening again ({quiet})")
            baud, macs, frames = await loop.run_in_executor(None, survey, serial, s.get("baud", "auto"), max(listen_s, 5.0))
        bip.log(f"survey of {serial}: {baud} baud, {frames} frames, stations {sorted(macs)}")
        mac = s.get("mac", "auto")
        if mac == "auto":
            # MS/TP token passing prefers low addresses, so a fresh trunk (nothing heard)
            # gets a high one where a controller is least likely to sit
            free = [m for m in range(1, 128) if m not in macs and m not in self.avoid]
            if frames == 0 or len(macs) < 2:
                free.reverse()  # not sure what is out there: stay clear of the low addresses
            elif macs:
                # controllers usually sit in one low block: take the first free address above
                # them, so a station that was quiet during the survey is unlikely to be ours
                above = [m for m in free if m > max(macs)]
                free = above or free
            if not free:
                raise bip.DriverError("bad_request", "no free MS/TP MAC address on this trunk")
            mac = free[-1] if s.get("mac_pick") == "high" else free[0]
        elif int(mac) in macs:
            raise bip.DriverError("bad_request", f"MAC {mac} is already used on this trunk")
        name = s.get("name_suffix") or os.path.basename(serial).replace("tty", "")
        self.ns = f"heapy-mstp-{name}"
        pfx = s.get("link", "10.255.77")
        self.plan = {"serial": serial, "baud": baud, "mac": int(mac), "heard": frames, "max_master": int(s.get("max_master", 127)),
                     "max_info_frames": int(s.get("max_info_frames", 1)), "trunk_net": int(s.get("trunk_net", 3001)),
                     "router": router, "peer": None}
        self.plan["peer"] = self._link_up(name, pfx)
        self._start_router()
        if not self.watch:
            self.watch = asyncio.create_task(self._watch_router())
        await asyncio.sleep(2)
        inner = {"address": f"{pfx}.1/24", "instance": s.get("instance", 4194002), "name": s.get("name", "HEAPY-Edge-MSTP"),
                 "apdu_timeout_ms": s.get("apdu_timeout_ms", 3000)}
        await super().op_configure({"settings": inner})
        self.clash = None  # anything heard while we were leaving the trunk is about the old address
        return {"ok": True, "baud": baud, "mac": int(mac), "macs_in_use": sorted(macs), "frames_heard": frames}

    async def op_discover(self, req):
        # A device announcing itself on OUR address means two stations share it (a
        # controller that was quiet or powered off while we listened). The trunk keeps
        # limping along, but that controller can never be read and both stations clash
        # on every token. So before the real discovery: a short Who-Is, and if any I-Am
        # comes from our own address, leave, listen again and rejoin on a free one.
        for _ in range(3):
            if self.clash is None:
                # a station sharing our address only gets the token now and then: ask a few times
                for _k in range(3):
                    await self._who_is([(0, 4194303)], bip.Address("*:*"), 2.0, float(req.get("rate", 5)))
                    if self.clash is not None:
                        break
            if self.clash is None:
                break
            bad = self.clash
            bip.log(f"another station uses our MS/TP address {bad}; leaving the trunk to listen again")
            await bip.emit({"id": None, "event": "log", "data": {"level": "warn", "msg": f"MS/TP: address {bad} is also used by a controller; rejoining on another"}})
            self.avoid.add(bad)
            await self.op_configure({"settings": self.settings_in})
        r = await super().op_discover(req)
        if self.clash is not None:  # showed up during the real discovery instead
            r["rejoin_needed"] = True
        return r

    async def op_read(self, req):
        if self.clash is not None and not self.rejoining:
            # a station on our address turned up after discovery: fix it before the next read
            self.rejoining = True
            try:
                bad = self.clash
                self.clash = None
                self.avoid.add(bad)
                bip.log(f"another station uses our MS/TP address {bad}; leaving the trunk to listen again")
                await bip.emit({"id": None, "event": "log", "data": {"level": "warn", "msg": f"MS/TP: address {bad} is also used by a controller; rejoining on another"}})
                await self.op_configure({"settings": self.settings_in})
            finally:
                self.rejoining = False
        return await super().op_read(req)

    def _hook_iam(self, app):
        super()._hook_iam(app)
        inner = app.do_IAmRequest

        async def do_iam(apdu):
            # routes look like "3001:4" (network:MAC) for stations on our own trunk
            try:
                net, _, mac = str(apdu.pduSource).partition(":")
                if net == str(self.plan.get("trunk_net")) and mac.isdigit() and int(mac) == self.plan.get("mac"):
                    self.clash = int(mac)
            except Exception:
                pass
            await inner(apdu)
        app.do_IAmRequest = do_iam

    async def op_shutdown(self, req):
        if self.router and self.router.poll() is None:
            self.router.terminate()
        if self.ns:
            subprocess.run(["ip", "netns", "del", self.ns], capture_output=True)
        return await super().op_shutdown(req)


if __name__ == "__main__":
    import asyncio as _a
    _a.run(bip.main(MstpDriver))
