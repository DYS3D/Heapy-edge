"""
HEAPY Edge - simulated BACnet site for testing.

Runs many BACnet devices in one process:
  * BACnet/IP devices, one per IP address (a plant controller and AHU controllers)
  * one BACnet/IP-to-trunk router (like an MS/TP router) with VAV controllers
    behind it on a virtual network, so routed discovery and reads are tested
Values change every few seconds. Some devices are made awkward on purpose:
slow replies, no ReadPropertyMultiple support, no COV.

Run inside the bas-sim network namespace (see netsetup.sh):
  ip netns exec bas-sim python3 bacnet_sim.py --ahus 6 --vavs 40
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
from bacpypes3.apdu import RejectPDU, ReadPropertyMultipleRequest
from bacpypes3.basetypes import EngineeringUnits, PropertyIdentifier
from bacpypes3.errors import RejectException
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


class SimDevice:
    """One simulated device: a bacpypes3 Application plus its value functions."""

    def __init__(self, instance, name, port_obj, points, vendor, model,
                 slow=0.0, no_rpm=False, no_cov=False):
        dev = DeviceObject(
            objectIdentifier=("device", instance), objectName=name,
            vendorIdentifier=vendor[0], vendorName=vendor[1], modelName=model,
            description=f"Simulated {model}")
        objs = [dev, port_obj]
        self.funcs = []
        counters = {}
        for kind, pname, units, fn, desc in points:
            counters[kind] = counters.get(kind, 0) + 1
            i = counters[kind]
            if kind == "ai":
                o = AnalogInputObject(objectIdentifier=("analog-input", i), objectName=pname,
                                      presentValue=fn(time.time()), units=units, description=desc,
                                      covIncrement=0.5)
            elif kind == "ao":
                o = AnalogOutputObject(objectIdentifier=("analog-output", i), objectName=pname,
                                       presentValue=fn(time.time()), units=units, description=desc,
                                       relinquishDefault=0.0, covIncrement=0.5)
            elif kind == "av":
                o = AnalogValueObject(objectIdentifier=("analog-value", i), objectName=pname,
                                      presentValue=fn(time.time()), units=units, description=desc,
                                      covIncrement=0.5)
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
                                          stateText=["Unoccupied", "Occupied", "Standby"],
                                          description=desc)
            else:
                raise ValueError(kind)
            objs.append(o)
            if kind in ("ai", "ao", "av"):
                self.funcs.append((o, fn))
        self.app = Application.from_object_list(objs)
        self.name, self.instance, self.slow = name, instance, slow
        self.stats = {"requests": 0, "rpm": 0, "max_rate": 0.0}
        self._window = []
        self._patch(no_rpm, no_cov)

    def _patch(self, no_rpm, no_cov):
        app, slow, stats, window = self.app, self.slow, self.stats, self._window
        orig_indication = app.indication

        async def indication(apdu):
            now = time.time()
            window.append(now)
            while window and window[0] < now - 1.0:
                window.pop(0)
            stats["requests"] += 1
            stats["max_rate"] = max(stats["max_rate"], len(window))
            if isinstance(apdu, ReadPropertyMultipleRequest):
                stats["rpm"] += 1
            if slow:
                await asyncio.sleep(slow)
            return await orig_indication(apdu)

        app.indication = indication
        if no_rpm:
            async def no_rpm_handler(apdu):
                raise RejectException("unrecognized-service")
            app.do_ReadPropertyMultipleRequest = no_rpm_handler
        if no_cov:
            async def no_cov_handler(apdu):
                raise RejectException("unrecognized-service")
            app.do_SubscribeCOVRequest = no_cov_handler

    def tick(self, t):
        for o, fn in self.funcs:
            o.presentValue = fn(t)


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


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="10.77.0.", help="first three octets")
    p.add_argument("--first", type=int, default=10)
    p.add_argument("--ahus", type=int, default=6)
    p.add_argument("--vavs", type=int, default=40)
    p.add_argument("--trunk-net", type=int, default=2001)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--tick", type=float, default=5.0)
    p.add_argument("--stats", default="", help="write per-device request stats to this JSON file")
    a = p.parse_args()
    rng = random.Random(a.seed)
    random.seed(a.seed)

    devices = []
    ipn = a.first
    jci, siemens, alc = (5, "Johnson Controls"), (7, "Siemens"), (24, "Automated Logic")

    # plant controller
    devices.append(SimDevice(1100, "CUP-PLANT", ip_port(f"{a.base}{ipn}/24"), plant_points(rng),
                             siemens, "PXC36"))
    ipn += 1
    # AHU controllers: AHU-2 is slow, AHU-3 has no RPM, AHU-4 has no COV
    for n in range(1, a.ahus + 1):
        devices.append(SimDevice(1200 + n, f"AHU-{n}", ip_port(f"{a.base}{ipn}/24"),
                                 ahu_points(n, rng), jci, "FEC2611",
                                 slow=0.6 if n == 2 else 0.0, no_rpm=(n == 3), no_cov=(n == 4)))
        ipn += 1
    # router to a virtual trunk with VAV controllers (like an MS/TP router)
    VirtualNetwork("trunk1")
    router = SimDevice(1300, "RTR-TRUNK1",
                       ip_port(f"{a.base}{ipn}/24", net=100), [], alc, "BACnet router")
    router.app.add_object(vport(1, a.trunk_net, "trunk1", idx=2))
    devices.append(router)
    for n in range(1, a.vavs + 1):
        mac = n + 1
        devices.append(SimDevice(20000 + n, f"VAV-{n:02d}", vport(mac, a.trunk_net, "trunk1"),
                                 vav_points(n, rng), alc, "ZN341V+",
                                 slow=0.25 if n % 10 == 0 else 0.0, no_cov=True))
    print(json.dumps({"ready": True, "devices": len(devices),
                      "ip": [f"{a.base}{a.first}", f"{a.base}{ipn}"], "trunk_net": a.trunk_net}),
          flush=True)

    while True:
        t = time.time()
        for d in devices:
            d.tick(t)
        if a.stats:
            with open(a.stats, "w") as f:
                json.dump({d.name: d.stats for d in devices}, f)
        await asyncio.sleep(a.tick)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
