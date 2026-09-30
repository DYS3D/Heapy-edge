"""
HEAPY Edge - virtual RS-485 bus for MS/TP (and Modbus RTU) testing.

Creates N serial ports (pseudo-terminals). Every byte written to one port is
delivered to all the others, like devices wired on one twisted pair. Faults can
be injected at run time through a control socket (JSON lines):
  {"cmd":"noise","rate":50}          random bytes per second on the wire
  {"cmd":"drop","p":0.001}           share of bytes lost
  {"cmd":"cut","port":3,"on":true}   port 3 hears nothing and is not heard
  {"cmd":"stats"}                    bytes moved per port

  python3 rs485_bus.py --ports 8 --control /tmp/bus.sock   (prints the port paths)
"""

import argparse
import asyncio
import json
import os
import pty
import random
import sys
import termios
import tty


class Bus:
    def __init__(self, n):
        self.masters, self.slaves = [], []
        for _ in range(n):
            m, s = pty.openpty()
            tty.setraw(m)
            tty.setraw(s)
            attrs = termios.tcgetattr(s)
            attrs[3] &= ~termios.ECHO
            termios.tcsetattr(s, termios.TCSANOW, attrs)
            os.set_blocking(m, False)
            self.masters.append(m)
            self.slaves.append(os.ttyname(s))
            self._keep = getattr(self, "_keep", []) + [s]  # keep the slave side open
        self.cut = set()
        self.noise = 0.0
        self.drop = 0.0
        self.stats = [0] * n

    def send(self, src, data):
        if self.drop:
            data = bytes(b for b in data if random.random() >= self.drop)
        for i, m in enumerate(self.masters):
            if i == src or i in self.cut or not data:
                continue
            try:
                os.write(m, data)
            except (BlockingIOError, OSError):
                pass  # nobody listening on that port right now

    def on_read(self, i):
        try:
            data = os.read(self.masters[i], 4096)
        except (BlockingIOError, OSError):
            return
        self.stats[i] += len(data)
        if i in self.cut:
            return
        self.send(i, data)

    async def noise_loop(self):
        while True:
            if self.noise > 0:
                self.send(-1, bytes([random.randrange(256)]))
                await asyncio.sleep(1.0 / self.noise)
            else:
                await asyncio.sleep(0.2)

    async def control(self, reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                r = json.loads(line)
                c = r["cmd"]
                out = {"ok": True}
                if c == "noise":
                    self.noise = float(r.get("rate", 0))
                elif c == "drop":
                    self.drop = float(r.get("p", 0))
                elif c == "cut":
                    (self.cut.add if r.get("on", True) else self.cut.discard)(int(r["port"]))
                elif c == "stats":
                    out["stats"] = self.stats
                else:
                    raise ValueError(c)
            except Exception as e:
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ports", type=int, default=8)
    p.add_argument("--control", default="")
    a = p.parse_args()
    bus = Bus(a.ports)
    loop = asyncio.get_running_loop()
    for i, m in enumerate(bus.masters):
        loop.add_reader(m, bus.on_read, i)
    asyncio.create_task(bus.noise_loop())
    if a.control:
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(bus.control, path=a.control)
    print(json.dumps({"ready": True, "ports": bus.slaves}), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
