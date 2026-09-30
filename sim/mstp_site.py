"""
HEAPY Edge - simulated MS/TP trunk: a virtual RS-485 bus with N bacnet-stack
MS/TP devices (MAC 1..N, device numbers 30001..). Port 0 is left free for the
box. Control socket (JSON lines):
  {"cmd":"offline","mac":3,"on":true}     power a device off / back on
  {"cmd":"noise","rate":20}               random bytes per second on the wire
  {"cmd":"drop","p":0.001}                share of bytes lost
  {"cmd":"cut","port":0,"on":true}        disconnect a port (0 = the box)
  {"cmd":"list"}

  python3 mstp_site.py --devices 30 --control /tmp/mstp.sock
"""

import argparse
import asyncio
import ctypes
import json
import os
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, HERE)
from rs485_bus import Bus  # noqa: E402


def _die_with_parent():
    ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG


class Site:
    def __init__(self, a, bus):
        self.a, self.bus = a, bus
        self.procs = {}

    def start_dev(self, mac):
        port = self.bus.slaves[mac]
        env = dict(os.environ, BACNET_IFACE=port, BACNET_MSTP_MAC=str(mac), BACNET_MSTP_BAUD="38400",
                   BACNET_MAX_MASTER=str(self.a.max_master), BACNET_MAX_INFO_FRAMES="1")
        self.procs[mac] = subprocess.Popen([os.path.join(BIN, "bacserv-mstp"), str(30000 + mac), f"MSTP-DEV-{mac:03d}"],
                                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           preexec_fn=_die_with_parent)

    def stop_dev(self, mac):
        p = self.procs.pop(mac, None)
        if p and p.poll() is None:
            p.send_signal(signal.SIGKILL)
            p.wait()

    async def control(self, reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                r = json.loads(line)
                c, out = r["cmd"], {"ok": True}
                if c == "offline":
                    (self.stop_dev if r.get("on", True) else self.start_dev)(int(r["mac"]))
                elif c == "noise":
                    self.bus.noise = float(r.get("rate", 0))
                elif c == "drop":
                    self.bus.drop = float(r.get("p", 0))
                elif c == "cut":
                    (self.bus.cut.add if r.get("on", True) else self.bus.cut.discard)(int(r["port"]))
                elif c == "list":
                    out["devices"] = {m: p.poll() is None for m, p in self.procs.items()}
                    out["bytes"] = self.bus.stats
                else:
                    raise ValueError(c)
            except Exception as e:
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--devices", type=int, default=10)
    p.add_argument("--max-master", type=int, default=127)
    p.add_argument("--control", default="")
    a = p.parse_args()
    bus = Bus(a.devices + 1)
    loop = asyncio.get_running_loop()
    for i, m in enumerate(bus.masters):
        loop.add_reader(m, bus.on_read, i)
    asyncio.create_task(bus.noise_loop())
    site = Site(a, bus)
    for mac in range(1, a.devices + 1):
        site.start_dev(mac)
    if a.control:
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(site.control, path=a.control)
    print(json.dumps({"ready": True, "box_port": bus.slaves[0], "devices": a.devices}), flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        for mac in list(site.procs):
            site.stop_dev(mac)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
