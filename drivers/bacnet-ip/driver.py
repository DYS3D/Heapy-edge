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

from bacpypes3.apdu import AbortPDU, ErrorRejectAbortNack, RejectPDU
from bacpypes3.app import Application
from bacpypes3.argparse import SimpleArgumentParser
from bacpypes3.basetypes import ErrorType
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import ObjectIdentifier

VERSION = "0.2.0"
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


def _finite(o: Any) -> Any:
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_finite(v) for v in o]
    return o


async def emit(obj: Dict[str, Any]) -> None:
    try:
        line = json.dumps(obj, default=str, separators=(",", ":"), allow_nan=False)
    except ValueError:  # NaN or infinity somewhere: never send invalid JSON
        line = json.dumps(_finite(obj), default=str, separators=(",", ":"), allow_nan=False)
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


APDU_TIMEOUT_MS = 3000  # BACnet default; raise it (settings.apdu_timeout_ms) for very slow networks
APDU_RETRIES = 3        # BACpypes3 gives up after 3 s x (1 + 3) = 12 s
REQ_TIMEOUT = 16.0
RPM_RETRY_S = 3600.0   # try ReadPropertyMultiple again an hour after a device refused it


def dev_instance(key: str) -> int:
    # bacnet://1201   or   bacnet://1201~10.77.0.19 (second device using the same number)
    return int(key.split("://", 1)[1].split("/", 1)[0].split("~", 1)[0])


def point_obj(key: str) -> Tuple[str, int]:
    # bacnet://1201/analog-input:5
    obj = key.split("://", 1)[1].split("/", 1)[1]
    t, i = obj.split(":")
    return t, int(i)


def app_read(app, addr, obj, prop, index=None):
    oid = obj if isinstance(obj, ObjectIdentifier) else ObjectIdentifier(obj)
    return app.read_property(addr, oid, prop, index)


class Err(str):
    """A property that came back as a BACnet error (e.g. 'object: unknown-object')."""


def clean(v: Any) -> Any:
    if isinstance(v, ErrorType):
        return Err(f"{v.errorClass}: {v.errorCode}")
    return v


def classify(e: BaseException) -> Tuple[str, str]:
    """(kind, text): timeout | no_rpm | too_big | error"""
    if isinstance(e, asyncio.TimeoutError):
        return "timeout", "no answer"
    txt = str(e)
    if isinstance(e, AbortPDU):
        if "no-response" in txt or "timeout" in txt:
            return "timeout", "no answer"
        if any(w in txt for w in ("segmentation", "buffer-overflow", "apdu-too-long", "window")):
            return "too_big", txt
        return "error", f"abort: {txt}"
    if isinstance(e, RejectPDU):
        if "unrecognized-service" in txt:
            return "no_rpm", txt
        if "buffer-overflow" in txt:
            return "too_big", txt
        return "error", f"reject: {txt}"
    return "error", txt


POINT_ERRORS = ("unknown-object", "unknown-property", "read-access-denied")


def to_number(v: Any) -> Tuple[Optional[float], Optional[str]]:
    if v is None:
        return None, "no value"
    if isinstance(v, Err):
        return None, str(v)
    s = str(v)
    if s == "active":
        return 1, None
    if s == "inactive":
        return 0, None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None, f"not a number ({s[:40]})"
    if f != f or f in (float("inf"), float("-inf")):
        return None, f"invalid value ({s})"
    if isinstance(v, float):
        return float(format(f, ".7g")), None  # BACnet REAL is 32-bit: drop float noise
    return (int(f) if f.is_integer() else f), None


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
        self.no_rpm: Dict[str, float] = {}  # device key -> when it refused RPM
        self.cov_tasks: Dict[str, asyncio.Task] = {}
        self.collectors: List[Dict[Tuple[int, str], Any]] = []

    # ---- setup -------------------------------------------------------------
    async def op_hello(self, req):
        return {"driver": "bacnet-ip", "version": VERSION, "scheme": SCHEME,
                "capabilities": ["discover", "browse", "read", "subscribe", "locate"]}

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
        global REQ_TIMEOUT
        to = int(s.get("apdu_timeout_ms", APDU_TIMEOUT_MS))
        tries = int(s.get("apdu_retries", APDU_RETRIES))
        self.app.device_object.apduTimeout = to
        self.app.device_object.numberOfApduRetries = tries
        self.app.asap.apduTimeout = to
        self.app.asap.numberOfApduRetries = tries
        REQ_TIMEOUT = to / 1000.0 * (tries + 1) + 4
        self._hook_iam(self.app)
        await asyncio.sleep(0.2)
        return {"ok": True}

    def _hook_iam(self, app):
        """Tell the core when a device announces itself (e.g. after a restart), at most once a minute per device."""
        orig = app.do_IAmRequest
        last: Dict[Tuple[int, str], float] = {}

        async def do_iam(apdu):
            await orig(apdu)
            try:
                inst, route = int(apdu.iAmDeviceIdentifier[1]), str(apdu.pduSource)
            except Exception:
                return
            # every I-Am goes to the Who-Is collectors, including two devices
            # that use the same device number (BACpypes3 keeps only one of those)
            for col in self.collectors:
                col.setdefault((inst, route), apdu)
            now = time.monotonic()
            if now - last.get((inst, route), -1e9) < 60:
                return
            last[(inst, route)] = now
            if len(last) > 20000:
                last.clear()
            await emit({"id": None, "event": "iam", "data": {"instance": inst, "route": route,
                                                            "key": f"{SCHEME}://{inst}"}})

        app.do_IAmRequest = do_iam

    def need_app(self) -> Application:
        if not self.app:
            raise DriverError("bad_request", "configure first")
        return self.app

    # ---- discovery ---------------------------------------------------------
    async def _who_is(self, spans, dest, timeout, rate, rid=None):
        """Who-Is over the spans; returns {(instance, route): IAm}."""
        app = self.need_app()
        found: Dict[Tuple[int, str], Any] = {}
        me = int(self.settings.get("instance", 4194001))
        for i, (lo, hi) in enumerate(spans):
            await self.limiter.wait("__net__", rate)
            col: Dict[Tuple[int, str], Any] = {}
            self.collectors.append(col)
            try:
                fut = app.who_is(lo, hi, address=dest, timeout=timeout)
                await asyncio.sleep(timeout)  # collect every answer for the full time
                if not fut.done():
                    fut.cancel()
            finally:
                self.collectors.remove(col)
            for (inst, route), iam in col.items():
                if inst != me and lo <= inst <= hi:
                    found.setdefault((inst, route), iam)
            if rid is not None and len(spans) > 1:
                await emit({"id": rid, "event": "progress", "data": {"done": i + 1, "of": len(spans)}})
        return found

    async def op_discover(self, req):
        self.need_app()
        rid = req["id"]
        rate = float(req.get("rate", 5))
        timeout = float(req.get("timeout_s", 5))
        targets = req.get("targets") or {}
        ranges = targets.get("ranges") or [[0, 4194303]]
        chunk = int(targets.get("chunk", 0))
        passes = int(targets.get("passes", 2))
        known_list = req.get("known") or [{"key": k} for k in (req.get("known_keys") or [])]
        known = sorted({dev_instance(k["key"]) for k in known_list})
        known_route = {k["key"]: k.get("route") for k in known_list}

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
        found: Dict[Tuple[int, str], Any] = {}
        # several passes: on a busy network some I-Am replies are lost
        for _ in range(max(1, passes)):
            found.update(await self._who_is(spans, dest, timeout, rate, rid))
        # devices seen before but missing now get a Who-Is of their own
        seen = {inst for inst, _ in found}
        for inst in known:
            if inst not in seen:
                found.update(await self._who_is([(inst, inst)], dest, timeout, rate))

        by_inst: Dict[int, List[Tuple[str, Any]]] = {}
        for (inst, route), iam in found.items():
            by_inst.setdefault(inst, []).append((route, iam))

        # read name / vendor / model for each device, one device at a time
        n = dups = 0
        for inst in sorted(by_inst):
            # the address already known for this device number keeps the plain key,
            # so a second device with the same number never takes over its history
            home = known_route.get(f"{SCHEME}://{inst}")
            entries = sorted(by_inst[inst], key=lambda x: (x[0] != home, x[0]))
            for k, (route, iam) in enumerate(entries):
                key = f"{SCHEME}://{inst}" if k == 0 else f"{SCHEME}://{inst}~{route}"
                meta = {"max_apdu": int(iam.maxAPDULengthAccepted),
                        "segmentation": str(iam.segmentationSupported),
                        "vendor_id": int(iam.vendorID)}
                if len(entries) > 1:
                    meta["duplicate_id"] = [r for r, _ in entries]
                    dups += 1
                name = vendor = model = None
                try:
                    vals = await self._read_props(key, iam.pduSource, meta, rate,
                                                  [(("device", inst), ["object-name", "vendor-name", "model-name", "description"])])
                    d = {k2: (None if isinstance(v, Err) else v) for k2, v in vals.get(("device", inst), {}).items()}
                    name, vendor, model = d.get("object-name"), d.get("vendor-name"), d.get("model-name")
                    meta["description"] = d.get("description")
                except DriverError as e:
                    meta["error"] = e.code
                await emit({"id": rid, "event": "device", "data": {
                    "key": key, "route": route, "name": name or f"Device {inst}",
                    "vendor": vendor, "model": model, "meta": meta}})
                n += 1
        if dups:
            log(f"{dups} devices share a device number with another device")
        return {"devices": n, "duplicate_ids": dups}

    async def op_locate(self, req):
        """Find where a device is now (after an IP change or router change)."""
        dev = req["device"]
        inst = dev_instance(dev["key"])
        found = await self._who_is([(inst, inst)], Address("*:*"), float(req.get("timeout_s", 3)), 5)
        routes = sorted(r for (i, r) in found if i == inst)
        if "~" in dev["key"]:
            return {"route": dev["route"] if dev["route"] in routes else None, "routes": routes}
        return {"route": dev["route"] if dev["route"] in routes else (routes[0] if routes else None), "routes": routes}

    # ---- property reads ----------------------------------------------------
    def rpm_ok(self, key: str) -> bool:
        t = self.no_rpm.get(key)
        if t is None:
            return True
        if time.monotonic() - t > RPM_RETRY_S:
            del self.no_rpm[key]
            return True
        return False

    async def _rp(self, key, addr, obj, prop, rate, index=None):
        await self.limiter.wait(key, rate)
        try:
            return await asyncio.wait_for(app_read(self.need_app(), addr, obj, prop, index), REQ_TIMEOUT)
        except (ErrorRejectAbortNack, asyncio.TimeoutError) as e:
            kind, txt = classify(e)
            if kind == "timeout":
                raise DriverError("timeout", f"{key} did not answer")
            return Err(txt)

    async def _read_props(self, key: str, addr: Address, meta: Dict, rate: float,
                          items: List[Tuple[Tuple[str, int], List[str]]]) -> Dict:
        """Read properties for several objects. ReadPropertyMultiple in chunks sized to
        the device; ReadProperty when a device or a chunk can't do RPM. Errors for a
        single property come back as Err values, never as exceptions.

        Lost replies: once the device has answered in this call, one unanswered request
        only marks its own properties 'no answer' and the rest are still read; a second
        one means the device went away, and everything left is marked 'no answer'.
        DriverError("timeout") is raised only if the device never answered at all."""
        app = self.need_app()
        out: Dict[Tuple[str, int], Dict[str, Any]] = {}
        size = chunk_size(int(meta.get("max_apdu") or 480))
        per_obj = max(1, max((len(p) for _, p in items), default=1))
        size = max(1, size // per_obj if per_obj > 1 else size)
        answered = False
        misses = 0
        NO_ANSWER = Err("no answer")

        def give_up(rest):
            for obj, props in rest:
                for prop in props:
                    out.setdefault((obj[0], obj[1]), {}).setdefault(prop, NO_ANSWER)

        def missed(part):
            nonlocal misses
            if not answered:
                raise DriverError("timeout", f"{key} did not answer")
            misses += 1
            give_up(part)
            return misses >= 2

        i = 0
        while i < len(items):
            part = items[i:i + size]
            i += len(part)
            if self.rpm_ok(key) and meta.get("supports_rpm", True):
                params: List[Any] = []
                for obj, props in part:
                    params.append(ObjectIdentifier(obj))
                    params.append(props)
                await self.limiter.wait(key, rate)
                try:
                    res = await asyncio.wait_for(app.read_property_multiple(addr, params), REQ_TIMEOUT)
                    answered = True
                    for objid, prop, idx, val in res:
                        out.setdefault((str(objid[0]), int(objid[1])), {})[str(prop)] = clean(val)
                    continue
                except (ErrorRejectAbortNack, asyncio.TimeoutError) as e:
                    kind, txt = classify(e)
                    if kind == "timeout":
                        if missed(part):
                            give_up(items[i:])
                            break
                        continue
                    answered = True
                    if kind == "no_rpm":
                        self.no_rpm[key] = time.monotonic()
                        log(f"{key} does not support ReadPropertyMultiple; using ReadProperty for an hour")
                    elif kind == "too_big" and len(part) > 1:
                        size = max(1, len(part) // 2)
                        i -= len(part)
                        continue
                    # other errors: some devices refuse a whole RPM for one bad object;
                    # read this chunk one property at a time instead
            stop = False
            for n, (obj, props) in enumerate(part):
                for prop in props:
                    try:
                        v = await self._rp(key, addr, obj, prop, rate)
                        answered = True
                        out.setdefault((obj[0], obj[1]), {})[prop] = clean(v)
                    except DriverError:
                        if missed([(obj, [prop])]):
                            give_up(part[n:])
                            give_up(items[i:])
                            stop = True
                            break
                if stop:
                    break
            if stop:
                break
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
        ol = await self._rp(key, addr, devid, "object-list", rate)
        if not isinstance(ol, Err) and ol is not None:
            objects = [(str(o[0]), int(o[1])) for o in ol]
        else:
            # too big to send in one piece (no segmentation): read it one entry at a time
            count = await self._rp(key, addr, devid, "object-list", rate, 0)
            if isinstance(count, Err) or count is None:
                raise DriverError("rejected", f"object list: {count or ol}")
            for idx in range(1, int(count) + 1):
                o = await self._rp(key, addr, devid, "object-list", rate, idx)
                if isinstance(o, Err) or o is None:
                    continue
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
            v = {k: (None if isinstance(x, Err) else x) for k, x in vals.get((t, i), {}).items()}
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
        values, device_errors = [], []
        for pk, ((t, i), _) in zip(req["points"], items):
            v, err = to_number(vals.get((t, i), {}).get("present-value"))
            s = {"point": pk, "t": now, "v": v}
            if err:
                s["error"] = err
                if not any(w in err for w in POINT_ERRORS) and not err.startswith(("invalid", "not a number", "no answer")):
                    device_errors.append(err)
            values.append(s)
        if values and len(device_errors) == len(values):
            # the device answers but refuses every read: a device problem, not point problems
            raise DriverError("rejected", f"{key} refused the reads ({device_errors[0]})")
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
                    v, err = to_number(value)
                    if err:
                        continue
                    await emit({"id": None, "event": "cov", "data": {
                        "point": pk, "t": int(time.time() * 1000), "v": v}})
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
            import traceback
            log(f"error in {req.get('op')}: {e!r}\n{traceback.format_exc()}")
            await emit({"id": rid, "ok": False, "error": {"code": "internal", "message": repr(e)}})


async def main(driver_cls=None):
    drv = (driver_cls or Driver)()
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
