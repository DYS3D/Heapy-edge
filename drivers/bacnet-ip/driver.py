"""
HEAPY Edge BACnet/IP driver (contract v1, see contracts/driver-protocol.json).

Reads BACnet/IP devices and, through BACnet routers, devices on MS/TP,
ARCNET or other trunks. Read-only: this program never sends a write.
Library: BACpypes3 (BSD licence).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from bacpypes3.apdu import ErrorRejectAbortNack
from bacpypes3.app import Application
from bacpypes3.argparse import SimpleArgumentParser
from bacpypes3.basetypes import ErrorType
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import ObjectIdentifier

VERSION = "0.1.0"
SCHEME = "bacnet"

POINT_TYPES = {
    "analog-input": "number", "analog-output": "number", "analog-value": "number",
    "binary-input": "binary", "binary-output": "binary", "binary-value": "binary",
    "multi-state-input": "multistate", "multi-state-output": "multistate",
    "multi-state-value": "multistate", "accumulator": "number", "pulse-converter": "number",
    "large-analog-value": "number", "integer-value": "number",
    "positive-integer-value": "number", "loop": "number",
}
COV_TYPES = {"analog-input", "analog-output", "analog-value", "binary-input",
             "binary-output", "binary-value", "multi-state-input",
             "multi-state-output", "multi-state-value", "loop"}

out_lock = asyncio.Lock()


async def emit(obj: Dict[str, Any]) -> None:
    line = json.dumps(obj, default=str, separators=(",", ":"))
    async with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[bacnet-ip] {msg}\n")
    sys.stderr.flush()


class DriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Limiter:
    """Keeps requests to one device (or the whole network) at or under a rate."""

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


def dev_instance(key: str) -> int:
    # bacnet://1201
    return int(key.split("://", 1)[1].split("/", 1)[0])


def point_obj(key: str) -> Tuple[str, int]:
    # bacnet://1201/analog-input:5
    obj = key.split("://", 1)[1].split("/", 1)[1]
    t, i = obj.split(":")
    return t, int(i)


def clean(v: Any) -> Any:
    if isinstance(v, ErrorType):
        return None
    return v


def to_number(v: Any) -> Optional[float]:
    if v is None or isinstance(v, ErrorType):
        return None
    s = str(v)
    if s == "active":
        return 1
    if s == "inactive":
        return 0
    try:
        f = float(v)
        if isinstance(v, float):
            return float(format(f, ".7g"))  # BACnet REAL is 32-bit: drop float noise
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return None


def chunk_size(max_apdu: int) -> int:
    """Objects per ReadPropertyMultiple so replies fit without segmentation."""
    if max_apdu >= 1476:
        return 40
    if max_apdu >= 1024:
        return 28
    if max_apdu >= 480:
        return 12
    return 5


class Driver:
    def __init__(self) -> None:
        self.app: Optional[Application] = None
        self.settings: Dict[str, Any] = {}
        self.limiter = Limiter()
        self.no_rpm: set = set()          # device keys that rejected RPM
        self.cov_tasks: Dict[str, asyncio.Task] = {}

    # ---- setup -------------------------------------------------------------
    async def op_hello(self, req):
        return {"driver": "bacnet-ip", "version": VERSION, "scheme": SCHEME,
                "capabilities": ["discover", "browse", "read", "subscribe"]}

    async def op_configure(self, req):
        s = req.get("settings") or {}
        self.settings = s
        if self.app:
            self.app.close()
            self.app = None
        argv = ["--address", s.get("address", "host"),
                "--instance", str(s.get("instance", 4194001)),
                "--name", s.get("name", "HEAPY-Edge"),
                "--vendoridentifier", str(s.get("vendor_id", 999))]
        if s.get("network"):
            argv += ["--network", str(s["network"])]
        if s.get("foreign_bbmd"):
            argv += ["--foreign", s["foreign_bbmd"], "--ttl", str(s.get("foreign_ttl", 300))]
        args = SimpleArgumentParser().parse_args(argv)
        self.app = Application.from_args(args)
        await asyncio.sleep(0.2)
        return {"ok": True}

    def need_app(self) -> Application:
        if not self.app:
            raise DriverError("bad_request", "configure first")
        return self.app

    # ---- discovery ---------------------------------------------------------
    async def op_discover(self, req):
        app = self.need_app()
        rid = req["id"]
        rate = float(req.get("rate", 5))
        timeout = float(req.get("timeout_s", 5))
        targets = req.get("targets") or {}
        ranges = targets.get("ranges") or [[0, 4194303]]
        chunk = int(targets.get("chunk", 0))
        found: Dict[int, Any] = {}

        # split big ranges so a large site does not answer all at once
        spans: List[Tuple[int, int]] = []
        for lo, hi in ranges:
            if chunk and hi - lo + 1 > chunk:
                a = lo
                while a <= hi:
                    spans.append((a, min(hi, a + chunk - 1)))
                    a += chunk
            else:
                spans.append((lo, hi))
        dest = Address(targets["address"]) if targets.get("address") else Address("*:*")
        for i, (lo, hi) in enumerate(spans):
            await self.limiter.wait("__net__", rate)
            iams = await app.who_is(lo, hi, address=dest, timeout=timeout)
            for iam in iams:
                inst = iam.iAmDeviceIdentifier[1]
                if inst in found or inst == int(self.settings.get("instance", 4194001)):
                    continue
                found[inst] = iam
            if len(spans) > 1:
                await emit({"id": rid, "event": "progress", "data": {"done": i + 1, "of": len(spans)}})

        # read name / vendor / model for each device, one device at a time
        n = 0
        for inst, iam in sorted(found.items()):
            src = iam.pduSource
            route = str(src)
            key = f"{SCHEME}://{inst}"
            meta = {"max_apdu": int(iam.maxAPDULengthAccepted),
                    "segmentation": str(iam.segmentationSupported),
                    "vendor_id": int(iam.vendorID)}
            name = vendor = model = None
            try:
                vals = await self._read_props(key, src, meta, rate,
                                              [(("device", inst), ["object-name", "vendor-name", "model-name", "description"])])
                d = vals.get(("device", inst), {})
                name, vendor, model = d.get("object-name"), d.get("vendor-name"), d.get("model-name")
                meta["description"] = d.get("description")
            except DriverError as e:
                meta["error"] = e.code
            await emit({"id": rid, "event": "device", "data": {
                "key": key, "route": route, "name": name or f"Device {inst}",
                "vendor": vendor, "model": model, "meta": meta}})
            n += 1
        return {"devices": n}

    # ---- property reads ----------------------------------------------------
    async def _read_props(self, key: str, addr: Address, meta: Dict, rate: float,
                          items: List[Tuple[Tuple[str, int], List[str]]]) -> Dict:
        """Read properties for several objects; RPM in chunks, RP as fallback."""
        app = self.need_app()
        out: Dict[Tuple[str, int], Dict[str, Any]] = {}
        size = chunk_size(int(meta.get("max_apdu") or 480))
        # objects with several properties count for more of the reply
        per_obj = max(1, max((len(p) for _, p in items), default=1))
        size = max(1, size // per_obj if per_obj > 1 else size)
        i = 0
        while i < len(items):
            part = items[i:i + size]
            i += size
            if key not in self.no_rpm and meta.get("supports_rpm", True):
                params: List[Any] = []
                for obj, props in part:
                    params.append(ObjectIdentifier(obj))
                    params.append(props)
                await self.limiter.wait(key, rate)
                try:
                    res = await asyncio.wait_for(app.read_property_multiple(addr, params), 20)
                    for objid, prop, idx, val in res:
                        out.setdefault((str(objid[0]), int(objid[1])), {})[str(prop)] = clean(val)
                    continue
                except ErrorRejectAbortNack as e:
                    txt = str(e)
                    if "unrecognized-service" in txt or "unrecognized" in txt or "reject" in txt.lower():
                        self.no_rpm.add(key)
                        log(f"{key} does not support ReadPropertyMultiple, using ReadProperty")
                    elif "segmentation" in txt or "buffer" in txt or "abort" in txt.lower():
                        if size > 1:
                            size = max(1, size // 2)
                            i -= len(part)
                            continue
                        self.no_rpm.add(key)
                    else:
                        self.no_rpm.add(key)
                except asyncio.TimeoutError:
                    raise DriverError("timeout", f"{key} did not answer")
            # ReadProperty fallback, one property at a time
            for obj, props in part:
                for prop in props:
                    await self.limiter.wait(key, rate)
                    try:
                        v = await asyncio.wait_for(
                            app.read_property(addr, ObjectIdentifier(obj), prop), 10)
                        out.setdefault((obj[0], obj[1]), {})[prop] = clean(v)
                    except ErrorRejectAbortNack:
                        out.setdefault((obj[0], obj[1]), {})[prop] = None
                    except asyncio.TimeoutError:
                        raise DriverError("timeout", f"{key} did not answer")
        return out

    # ---- browse ------------------------------------------------------------
    async def op_browse(self, req):
        app = self.need_app()
        rid = req["id"]
        dev = req["device"]
        key, addr = dev["key"], Address(dev["route"])
        meta = dev.get("meta") or {}
        rate = float(req.get("rate", 5))
        inst = dev_instance(key)
        devid = ObjectIdentifier(("device", inst))

        objects: List[Tuple[str, int]] = []
        await self.limiter.wait(key, rate)
        try:
            ol = await asyncio.wait_for(app.read_property(addr, devid, "object-list"), 20)
            objects = [(str(o[0]), int(o[1])) for o in ol]
        except (ErrorRejectAbortNack, asyncio.TimeoutError):
            # too big to send in one piece: read it one entry at a time
            await self.limiter.wait(key, rate)
            try:
                count = int(await asyncio.wait_for(app.read_property(addr, devid, "object-list", 0), 10))
            except (ErrorRejectAbortNack, asyncio.TimeoutError) as e:
                raise DriverError("unreachable", f"object list: {e}")
            for idx in range(1, count + 1):
                await self.limiter.wait(key, rate)
                o = await asyncio.wait_for(app.read_property(addr, devid, "object-list", idx), 10)
                objects.append((str(o[0]), int(o[1])))

        wanted = [o for o in objects if o[0] in POINT_TYPES]
        items = []
        for t, i in wanted:
            kind = POINT_TYPES[t]
            props = ["object-name", "description"]
            if kind == "number":
                props.append("units")
            elif kind == "binary":
                props += ["inactive-text", "active-text"]
            else:
                props.append("state-text")
            items.append(((t, i), props))
        vals = await self._read_props(key, addr, meta, rate, items)
        n = 0
        for (t, i), props in items:
            v = vals.get((t, i), {})
            kind = POINT_TYPES[t]
            p = {"key": f"{key}/{t}:{i}", "name": v.get("object-name") or f"{t}:{i}",
                 "description": v.get("description") or "", "kind": kind,
                 "units": str(v["units"]) if v.get("units") is not None else None,
                 "cov": t in COV_TYPES}
            if kind == "binary":
                p["states"] = [v.get("inactive-text") or "inactive", v.get("active-text") or "active"]
            elif kind == "multistate" and v.get("state-text"):
                p["states"] = [str(s) for s in v["state-text"]]
            await emit({"id": rid, "event": "point", "data": p})
            n += 1
        return {"points": n, "objects": len(objects)}

    # ---- read --------------------------------------------------------------
    async def op_read(self, req):
        dev = req["device"]
        key, addr = dev["key"], Address(dev["route"])
        meta = dev.get("meta") or {}
        rate = float(req.get("rate", 5))
        items = []
        for pk in req["points"]:
            t, i = point_obj(pk)
            items.append(((t, i), ["present-value"]))
        vals = await self._read_props(key, addr, meta, rate, items)
        now = int(time.time() * 1000)
        values = []
        for pk, ((t, i), _) in zip(req["points"], items):
            raw = vals.get((t, i), {}).get("present-value")
            v = to_number(raw)
            s = {"point": pk, "t": now, "v": v}
            if v is None:
                s["error"] = "no value"
            values.append(s)
        return {"values": values}

    # ---- change of value ---------------------------------------------------
    async def op_subscribe(self, req):
        app = self.need_app()
        dev = req["device"]
        key, addr = dev["key"], Address(dev["route"])
        lifetime = int(req.get("lifetime_s", 900))
        ok, failed = [], []
        for pk in req["points"]:
            if pk in self.cov_tasks:
                ok.append(pk)
                continue
            t, i = point_obj(pk)
            started = asyncio.get_running_loop().create_future()
            task = asyncio.create_task(self._cov(app, addr, pk, (t, i), lifetime, started))
            try:
                await asyncio.wait_for(asyncio.shield(started), 10)
                self.cov_tasks[pk] = task
                ok.append(pk)
            except Exception:
                task.cancel()
                failed.append(pk)
        return {"subscribed": ok, "failed": failed}

    async def _cov(self, app, addr, pk, obj, lifetime, started):
        try:
            async with app.change_of_value(addr, ObjectIdentifier(obj), None, True, lifetime) as scm:
                if not started.done():
                    started.set_result(True)
                while True:
                    prop, value = await scm.get_value()
                    if str(prop) != "present-value":
                        continue
                    await emit({"id": None, "event": "cov", "data": {
                        "point": pk, "t": int(time.time() * 1000), "v": to_number(value)}})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not started.done():
                started.set_exception(e)
            else:
                log(f"COV ended for {pk}: {e!r}")
                self.cov_tasks.pop(pk, None)
                await emit({"id": None, "event": "log", "data": {"level": "warn", "msg": f"COV ended for {pk}"}})

    async def op_unsubscribe(self, req):
        for pk in req.get("points") or list(self.cov_tasks):
            t = self.cov_tasks.pop(pk, None)
            if t:
                t.cancel()
        return {"ok": True}

    async def op_shutdown(self, req):
        tasks = list(self.cov_tasks.values())
        for t in tasks:
            t.cancel()  # leaving the subscription context cancels it on the device
        if tasks:
            await asyncio.wait(tasks, timeout=3)
        if self.app:
            self.app.close()
        asyncio.get_running_loop().call_later(0.1, lambda: os._exit(0))
        return {"ok": True}

    # ---- plumbing ----------------------------------------------------------
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
        except ErrorRejectAbortNack as e:
            await emit({"id": rid, "ok": False, "error": {"code": "rejected", "message": str(e)}})
        except asyncio.TimeoutError:
            await emit({"id": rid, "ok": False, "error": {"code": "timeout", "message": "no answer"}})
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
