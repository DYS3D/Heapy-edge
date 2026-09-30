"""
HEAPY Edge - simulated BACnet site for testing and stress testing.

Runs many BACnet devices in one process:
  * BACnet/IP devices, one per IP address (a plant controller and AHU controllers)
  * one BACnet/IP-to-trunk router (like an MS/TP router) with VAV controllers
    behind it on a virtual network, so routed discovery and reads are tested
Values change every few seconds. Some devices are made awkward on purpose:
slow replies, no ReadPropertyMultiple support, no COV.

Run inside the bas-sim network namespace (see netsetup.sh):
  ip netns exec bas-sim python3 bacnet_sim.py --ahus 6 --vavs 40 --control /tmp/sim.sock

Faults are set at run time through the control socket (one JSON object per
line), e.g. {"cmd":"offline","device":1201,"on":true}. See CONTROL below.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
import time

from bacpypes3.app import Application
from bacpypes3.apdu import ConfirmedRequestPDU, RejectPDU, ReadPropertyMultipleRequest
from bacpypes3.basetypes import EngineeringUnits, PropertyIdentifier
from bacpypes3.errors import AbortException, ExecutionError, RejectException
from bacpypes3.local.analog import AnalogInputObject, AnalogOutputObject, AnalogValueObject
from bacpypes3.local.binary import BinaryInputObject, BinaryOutputObject, BinaryValueObject
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.multistate import MultiStateValueObject
from bacpypes3.local.networkport import NetworkPortObject
from bacpypes3.vlan import VirtualNetwork

U = EngineeringUnits
F, PCT, CFM, INWC, NONE, PSI, GPM = (
    U.degreesFahrenheit, U.percent, U.cubicFeetPerMinute, U.inchesOfWater,
    U.noUnits, U.poundsForcePerSquareInch, U.usGallonsPerMinute)

T0 = time.time()


def wave(period, lo, hi, phase=0.0, noise=0.0):
    """A value that moves between lo and hi over period seconds."""
    def f(t):
        v = lo + (hi - lo) * (0.5 + 0.5 * math.sin(2 * math.pi * (t - T0) / period + phase))
        return round(v + random.uniform(-noise, noise), 2)
    return f


def const(v):
    return lambda t: v


# point templates: (kind, name, units, value function, description)
def ahu_points(n, rng):
    ph = rng.random() * 6
    return [
        ("ai", f"AHU-{n}.SA-T", F, wave(600, 53, 58, ph, .3), "Supply air temperature"),
        ("ai", f"AHU-{n}.RA-T", F, wave(900, 70, 75, ph, .2), "Return air temperature"),
        ("ai", f"AHU-{n}.MA-T", F, wave(900, 60, 68, ph, .2), "Mixed air temperature"),
        ("ai", f"AHU-{n}.OA-T", F, wave(3600, 45, 80, 0, .1), "Outside air temperature"),
        ("ai", f"AHU-{n}.DSP", INWC, wave(300, 1.2, 1.6, ph, .02), "Duct static pressure"),
        ("av", f"AHU-{n}.DSP-SP", INWC, const(1.5), "Duct static pressure setpoint"),
        ("av", f"AHU-{n}.SAT-SP", F, const(55.0), "Supply air temperature setpoint"),
        ("ao", f"AHU-{n}.SF-SPD", PCT, wave(300, 55, 80, ph, 1), "Supply fan speed"),
        ("ao", f"AHU-{n}.CLG-VLV", PCT, wave(600, 10, 70, ph, 1), "Cooling valve"),
        ("ao", f"AHU-{n}.HTG-VLV", PCT, const(0.0), "Heating valve"),
        ("ao", f"AHU-{n}.OA-DMPR", PCT, wave(1200, 15, 40, ph, .5), "Outside air damper"),
        ("bi", f"AHU-{n}.SF-S", None, const(1), "Supply fan status"),
        ("bo", f"AHU-{n}.SF-C", None, const(1), "Supply fan command"),
        ("bi", f"AHU-{n}.FILT-ALM", None, const(0), "Filter alarm"),
        ("msv", f"AHU-{n}.OCC-MODE", None, const(2), "Occupancy mode"),
    ]


def plant_points(rng):
    return [
        ("ai", "CHW-S-T", F, wave(900, 43, 45, 0, .1), "Chilled water supply temperature"),
        ("ai", "CHW-R-T", F, wave(900, 53, 57, 0, .1), "Chilled water return temperature"),
        ("av", "CHW-S-SP", F, const(44.0), "Chilled water supply setpoint"),
        ("ai", "CHW-DP", PSI, wave(400, 11, 13, 0, .1), "Chilled water differential pressure"),
        ("ai", "CHW-FLOW", GPM, wave(900, 600, 900, 0, 5), "Chilled water flow"),
        ("bi", "CH-1-S", None, const(1), "Chiller 1 status"),
        ("bi", "CH-2-S", None, const(0), "Chiller 2 status"),
        ("bo", "CHWP-1-C", None, const(1), "Chilled water pump 1 command"),
        ("ao", "CHWP-1-SPD", PCT, wave(600, 60, 75, 0, .5), "Chilled water pump 1 speed"),
        ("ai", "CDW-S-T", F, wave(1800, 80, 85, 0, .1), "Condenser water supply temperature"),
        ("bv", "PLANT-ENA", None, const(1), "Plant enable"),
    ]


def vav_points(tag, rng):
    ph = rng.random() * 6
    return [
        ("ai", "ZN-T", F, wave(1200, 70, 74, ph, .1), "Zone temperature"),
        ("av", "ZN-SP", F, const(72.0), "Zone setpoint"),
        ("ai", "SA-FLOW", CFM, wave(600, 250, 650, ph, 5), "Supply airflow"),
        ("av", "SA-FLOW-SP", CFM, wave(600, 300, 600, ph, 0), "Supply airflow setpoint"),
        ("ao", "DMPR-POS", PCT, wave(600, 20, 80, ph, 1), "Damper position"),
        ("ao", "RHT-VLV", PCT, const(0.0), "Reheat valve"),
        ("ai", "DA-T", F, wave(600, 55, 60, ph, .2), "Discharge air temperature"),
        ("bv", "OCC", None, const(1), "Occupied"),
    ]


def generic_points(n_objs, rng):
    """A big controller (like a supervisory device exposing many points)."""
    out = []
    for i in range(n_objs):
        ph = rng.random() * 6
        out.append(("av", f"PT-{i + 1:05d}", F, wave(900, 60, 80, ph, .1), f"Generic point {i + 1}"))
    return out


class SimDevice:
    """One simulated device: a bacpypes3 Application, its value functions and its faults."""

    def __init__(self, instance, name, port_obj, points, vendor, model,
                 slow=0.0, no_rpm=False, no_cov=False, max_apdu=1024, segmentation="segmented-both"):
        self.args = dict(instance=instance, name=name, points=points, vendor=vendor, model=model,
                         slow=slow, no_rpm=no_rpm, no_cov=no_cov, max_apdu=max_apdu, segmentation=segmentation)
        dev = DeviceObject(
            objectIdentifier=("device", instance), objectName=name,
            vendorIdentifier=vendor[0], vendorName=vendor[1], modelName=model,
            description=f"Simulated {model}", maxApduLengthAccepted=max_apdu,
            segmentationSupported=segmentation)
        objs = [dev, port_obj]
        self.funcs = []
        self.counters = {}
        for kind, pname, units, fn, desc in points:
            objs.append(self._make(kind, pname, units, fn, desc))
        self.app = Application.from_object_list(objs)
        self.name, self.instance, self.slow = name, instance, slow
        self.stats = {"requests": 0, "rpm": 0, "max_rate": 0.0, "dropped": 0}
        self.fault = {"offline": False, "drop": 0.0, "slow": 0.0, "jitter": 0.0, "error": None, "odd": False}
        self.added = []
        self._window = []
        self._patch(no_rpm, no_cov)

    def _make(self, kind, pname, units, fn, desc):
        self.counters[kind] = self.counters.get(kind, 0) + 1
        i = self.counters[kind]
        if kind == "ai":
            o = AnalogInputObject(objectIdentifier=("analog-input", i), objectName=pname,
                                  presentValue=fn(time.time()), units=units, description=desc, covIncrement=0.5)
        elif kind == "ao":
            o = AnalogOutputObject(objectIdentifier=("analog-output", i), objectName=pname,
                                   presentValue=fn(time.time()), units=units, description=desc,
                                   relinquishDefault=0.0, covIncrement=0.5)
        elif kind == "av":
            o = AnalogValueObject(objectIdentifier=("analog-value", i), objectName=pname,
                                  presentValue=fn(time.time()), units=units, description=desc, covIncrement=0.5)
        elif kind == "bi":
            o = BinaryInputObject(objectIdentifier=("binary-input", i), objectName=pname,
                                  presentValue="active" if fn(0) else "inactive", description=desc)
        elif kind == "bo":
            o = BinaryOutputObject(objectIdentifier=("binary-output", i), objectName=pname,
                                   presentValue="active" if fn(0) else "inactive", description=desc,
                                   relinquishDefault="inactive")
        elif kind == "bv":
            o = BinaryValueObject(objectIdentifier=("binary-value", i), objectName=pname,
                                  presentValue="active" if fn(0) else "inactive", description=desc)
        elif kind == "msv":
            o = MultiStateValueObject(objectIdentifier=("multi-state-value", i), objectName=pname,
                                      presentValue=int(fn(0)), numberOfStates=3,
                                      stateText=["Unoccupied", "Occupied", "Standby"], description=desc)
        else:
            raise ValueError(kind)
        if kind in ("ai", "ao", "av"):
            self.funcs.append((o, fn))
        return o

    def _patch(self, no_rpm, no_cov):
        app, stats, window, fault, base_slow = self.app, self.stats, self._window, self.fault, self.slow
        orig_indication = app.indication

        async def indication(apdu):
            if fault["offline"] or (fault["drop"] and random.random() < fault["drop"]):
                stats["dropped"] += 1
                return None  # no reply at all, like a lost packet or a dead controller
            if isinstance(apdu, ConfirmedRequestPDU):
                # only requests addressed to this device count toward its rate
                # (broadcasts such as Who-Is and other devices' I-Ams don't)
                now = time.time()
                window.append(now)
                while window and window[0] < now - 1.0:
                    window.pop(0)
                stats["requests"] += 1
                stats["max_rate"] = max(stats["max_rate"], len(window))
            if isinstance(apdu, ReadPropertyMultipleRequest):
                stats["rpm"] += 1
            delay = base_slow + fault["slow"] + (random.uniform(0, fault["jitter"]) if fault["jitter"] else 0)
            if delay:
                await asyncio.sleep(delay)
            return await orig_indication(apdu)

        app.indication = indication

        def with_faults(orig):
            async def handler(apdu):
                e = fault["error"]
                if e == "reject":
                    raise RejectException("other")
                if e == "abort":
                    raise AbortException("other")
                if e == "error":
                    raise ExecutionError("device", "operational-problem")
                return await orig(apdu)
            return handler

        app.do_ReadPropertyRequest = with_faults(app.do_ReadPropertyRequest)
        app.do_ReadPropertyMultipleRequest = with_faults(app.do_ReadPropertyMultipleRequest)
        if no_rpm:
            async def no_rpm_handler(apdu):
                raise RejectException("unrecognized-service")
            app.do_ReadPropertyMultipleRequest = no_rpm_handler
        if no_cov:
            async def no_cov_handler(apdu):
                raise RejectException("unrecognized-service")
            app.do_SubscribeCOVRequest = no_cov_handler

    def tick(self, t):
        odd = [float("nan"), float("inf"), float("-inf"), 3.4e38] if self.fault["odd"] else []
        for i, (o, fn) in enumerate(self.funcs):
            o.presentValue = odd[i] if i < len(odd) else fn(t)

    def add_points(self, n):
        for _ in range(n):
            k = len(self.added) + 1
            o = self._make("av", f"{self.name}.NEW-{k}", F, const(50.0 + k), "Added while running")
            self.app.add_object(o)
            self.added.append(o)
        return len(self.added)

    def remove_points(self, n):
        gone = []
        for o, _ in list(self.funcs)[-n:]:
            self.app.delete_object(o)
            self.funcs = [(x, f) for x, f in self.funcs if x is not o]
            gone.append(f"{o.objectIdentifier[0]}:{o.objectIdentifier[1]}")
        return gone


def ip_port(addr, net=None):
    kw = {}
    if net:
        kw["networkNumber"] = net
        kw["networkNumberQuality"] = "configured"
    return NetworkPortObject(addr, objectIdentifier=("network-port", 1),
                             objectName="NetworkPort-1", **kw)


def vport(mac, net, ifname, idx=1):
    return NetworkPortObject(
        objectIdentifier=("network-port", idx), objectName=f"NetworkPort-{idx}",
        networkType="virtual", protocolLevel="bacnet-application",
        macAddress=bytes([mac]), networkNumber=net, networkNumberQuality="configured",
        networkInterfaceName=ifname, statusFlags=[0, 0, 0, 0],
        reliability="no-fault-detected", outOfService=False, changesPending=False,
        linkSpeed=76800.0)


# ---------------------------------------------------------------------------
# CONTROL: {"cmd": ..., ...} per line on the unix socket; reply {"ok":true,...}
#   list                                  devices with instance, name, route, faults
#   offline   device, on                  stop / resume answering
#   reboot    device, secs                offline for secs, then back with an I-Am
#   drop      device|"all", p             drop this share of requests (0..1)
#   slow      device|"all", secs, jitter  extra reply delay
#   error     device, kind|null           reject | abort | error for every read
#   odd       device, on                  NaN, inf, -inf and 3.4e38 values
#   add       device, n                   add n points
#   remove    device, n                   delete n points
#   move      device, ip                  device reappears at a new IP
#   duplicate device, ip                  second device with the same number
#   storm     secs, rate                  every IP device sends I-Am rate/s
#   stats                                 per-device request counts
# ---------------------------------------------------------------------------
class Site:
    def __init__(self, a):
        self.a = a
        self.devices = []
        self.by_inst = {}
        self.spare_ips = []

    def add(self, d, route):
        d.route = route
        self.devices.append(d)
        self.by_inst.setdefault(d.instance, []).append(d)
        return d

    def targets(self, sel):
        if sel == "all":
            return [d for d in self.devices if not d.fault["offline"]]
        return [d for d in self.by_inst.get(int(sel), []) if not getattr(d, "retired", False)][:1]

    async def control(self, reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                req = json.loads(line)
                out = await self.do(req)
                out["ok"] = True
            except Exception as e:  # report, keep serving
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()
        writer.close()

    async def do(self, r):
        c = r["cmd"]
        if c == "list":
            return {"devices": [{"instance": d.instance, "name": d.name, "route": d.route, "fault": d.fault,
                                 "retired": getattr(d, "retired", False)} for d in self.devices]}
        if c == "stats":
            return {"stats": {f"{d.name}@{d.route}": d.stats for d in self.devices}}
        if c == "storm":
            asyncio.create_task(self.storm(float(r.get("secs", 10)), float(r.get("rate", 5))))
            return {}
        if c in ("move", "duplicate"):
            d = self.targets(r["device"])[0]
            ip = r["ip"]
            args = dict(d.args)
            if c == "duplicate":
                args["name"] = d.name + "-DUP"
            else:
                d.fault["offline"] = True
                d.retired = True
            nd = SimDevice(port_obj=ip_port(f"{ip}/24"), **args)
            self.add(nd, ip)
            nd.app.i_am()
            return {"route": ip}
        ds = self.targets(r["device"])
        if not ds:
            raise ValueError("no such device")
        res = {}
        for d in ds:
            if c == "offline":
                d.fault["offline"] = bool(r.get("on", True))
                if not d.fault["offline"]:
                    d.app.i_am()
            elif c == "reboot":
                d.fault["offline"] = True
                asyncio.get_running_loop().call_later(float(r.get("secs", 30)), self._back, d)
            elif c == "drop":
                d.fault["drop"] = float(r.get("p", 0))
            elif c == "slow":
                d.fault["slow"] = float(r.get("secs", 0))
                d.fault["jitter"] = float(r.get("jitter", 0))
            elif c == "error":
                d.fault["error"] = r.get("kind")
            elif c == "odd":
                d.fault["odd"] = bool(r.get("on", True))
            elif c == "add":
                res["added"] = d.add_points(int(r.get("n", 1)))
            elif c == "remove":
                res["removed"] = d.remove_points(int(r.get("n", 1)))
            else:
                raise ValueError(f"unknown cmd {c}")
        return res

    def _back(self, d):
        d.fault["offline"] = False
        for o, fn in d.funcs:  # a restarted controller comes back with fresh values
            o.presentValue = fn(time.time())
        d.app.i_am()

    async def storm(self, secs, rate):
        end = time.time() + secs
        ipdevs = [d for d in self.devices if "." in d.route and not d.fault["offline"]]
        while time.time() < end:
            for d in ipdevs:
                d.app.i_am()
            await asyncio.sleep(1.0 / max(rate, 0.1))


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="10.77.0.", help="first three octets")
    p.add_argument("--first", type=int, default=10)
    p.add_argument("--ahus", type=int, default=6)
    p.add_argument("--vavs", type=int, default=40, help="VAVs on the first trunk")
    p.add_argument("--trunks", type=int, default=1, help="routers, each with its own trunk")
    p.add_argument("--vavs-per-trunk", type=int, default=0, help="VAVs on trunks 2..n (default: --vavs)")
    p.add_argument("--extra-ip", type=int, default=0, help="extra generic IP controllers")
    p.add_argument("--big", type=int, default=0, help="one IP device with this many objects")
    p.add_argument("--tiny", action="store_true", help="add a device with max APDU 50 and no segmentation")
    p.add_argument("--spare-ips", type=int, default=5, help="free addresses left for move/duplicate")
    p.add_argument("--trunk-net", type=int, default=2001)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--tick", type=float, default=5.0)
    p.add_argument("--stats", default="", help="write per-device request stats to this JSON file")
    p.add_argument("--control", default="", help="unix socket path for fault control")
    a = p.parse_args()
    rng = random.Random(a.seed)
    random.seed(a.seed)
    site = Site(a)

    ipn = a.first
    jci, siemens, alc, dist = (5, "Johnson Controls"), (7, "Siemens"), (24, "Automated Logic"), (178, "Distech Controls")

    def next_ip():
        nonlocal ipn
        ip = f"{a.base}{ipn}"
        ipn += 1
        return ip

    ip = next_ip()
    site.add(SimDevice(1100, "CUP-PLANT", ip_port(f"{ip}/24"), plant_points(rng), siemens, "PXC36"), ip)
    # AHU controllers: AHU-2 is slow, AHU-3 has no RPM, AHU-4 has no COV
    for n in range(1, a.ahus + 1):
        ip = next_ip()
        site.add(SimDevice(1200 + n, f"AHU-{n}", ip_port(f"{ip}/24"), ahu_points(n, rng), jci, "FEC2611",
                           slow=0.6 if n == 2 else 0.0, no_rpm=(n == 3), no_cov=(n == 4)), ip)
    for n in range(1, a.extra_ip + 1):
        ip = next_ip()
        site.add(SimDevice(3000 + n, f"CTRL-{n:03d}", ip_port(f"{ip}/24"), ahu_points(100 + n, rng)[:8],
                           dist, "ECY-S1000"), ip)
    if a.big:
        ip = next_ip()
        site.add(SimDevice(4000, "SUPERVISOR", ip_port(f"{ip}/24"), generic_points(a.big, rng),
                           dist, "EC-BOS"), ip)
    if a.tiny:
        ip = next_ip()
        site.add(SimDevice(4100, "OLD-UNIT", ip_port(f"{ip}/24"), vav_points(99, rng), jci, "Legacy",
                           max_apdu=50, segmentation="no-segmentation"), ip)
    # routers, each to its own virtual trunk of VAV controllers (like MS/TP routers)
    per = a.vavs_per_trunk or a.vavs
    for t in range(a.trunks):
        net = a.trunk_net + t
        ifname = f"trunk{t + 1}"
        VirtualNetwork(ifname)
        ip = next_ip()
        router = SimDevice(1300 + t, f"RTR-TRUNK{t + 1}", ip_port(f"{ip}/24", net=100), [], alc, "BACnet router")
        router.app.add_object(vport(1, net, ifname, idx=2))
        site.add(router, ip)
        count = a.vavs if t == 0 else per
        for n in range(1, count + 1):
            inst = 20000 + t * 1000 + n
            site.add(SimDevice(inst, f"VAV-{t + 1}-{n:03d}" if a.trunks > 1 else f"VAV-{n:02d}",
                               vport(n + 1, net, ifname), vav_points(inst, rng), alc, "ZN341V+",
                               slow=0.25 if n % 10 == 0 else 0.0, no_cov=True), f"{net}:{n + 1}")
    site.spare_ips = [f"{a.base}{ipn + i}" for i in range(a.spare_ips)]
    if a.control:
        import os
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(site.control, path=a.control)
    print(json.dumps({"ready": True, "devices": len(site.devices), "ip": [f"{a.base}{a.first}", f"{a.base}{ipn - 1}"],
                      "spare_ips": site.spare_ips, "trunk_net": a.trunk_net}), flush=True)

    while True:
        t = time.time()
        for d in site.devices:
            d.tick(t)
        if a.stats:
            with open(a.stats + ".tmp", "w") as f:
                json.dump({f"{d.name}@{d.route}": d.stats for d in site.devices}, f)
            import os
            os.replace(a.stats + ".tmp", a.stats)
        await asyncio.sleep(a.tick)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
