"""
HEAPY Edge SNMP driver (contract v1, see contracts/driver-protocol.json).

Reads UPSs, PDUs, generators, chillers and other devices over SNMP v1, v2c or v3
(auth + privacy). Read-only: only GET / GETNEXT / GETBULK are ever sent.
Library: pysnmp (BSD licence).

Settings (drivers.snmp.settings):
  devices: [{name, host, port (161), version: "1"|"2c"|"3", community,
             v3: {user, auth: SHA|SHA256|SHA512|MD5|none, auth_key,
                  priv: AES|AES192|AES256|DES|none, priv_key, context},
             template, points: [PointDef], walk: [subtree OIDs to list as points],
             timeout_ms (1500), retries (2), max_oids (20)}]
  templates: {name: {points: [PointDef]}}   (built in: ups-mib, system)
  PointDef: {name, oid, scale, offset, units, description, kind, states}
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import edge_driver as ed  # noqa: E402
from edge_driver import DriverError, emit, log  # noqa: E402

from pysnmp.hlapi.v3arch import asyncio as h  # noqa: E402
from pysnmp.proto import rfc1905  # noqa: E402

ed.NAME = "snmp"
VERSION = "0.1.0"
SCHEME = "snmp"
NAME_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
OID_OK = re.compile(r"^\.?\d+(\.\d+)+$")

UPS = "1.3.6.1.2.1.33.1."
BUILTIN = {
    "system": {"points": [
        {"name": "sysUpTime", "oid": "1.3.6.1.2.1.1.3.0", "scale": 0.01, "units": "seconds"},
    ]},
    "ups-mib": {"points": [
        {"name": "Battery status", "oid": UPS + "2.1.0", "kind": "multistate", "states": ["unknown", "normal", "low", "depleted"]},
        {"name": "Seconds on battery", "oid": UPS + "2.2.0", "units": "seconds"},
        {"name": "Minutes remaining", "oid": UPS + "2.3.0", "units": "minutes"},
        {"name": "Charge remaining", "oid": UPS + "2.4.0", "units": "percent"},
        {"name": "Battery voltage", "oid": UPS + "2.5.0", "scale": 0.1, "units": "volts"},
        {"name": "Battery temperature", "oid": UPS + "2.7.0", "units": "degrees-celsius"},
        {"name": "Input frequency", "oid": UPS + "3.3.1.2.1", "scale": 0.1, "units": "hertz"},
        {"name": "Input voltage", "oid": UPS + "3.3.1.3.1", "units": "volts"},
        {"name": "Output source", "oid": UPS + "4.1.0", "kind": "multistate",
         "states": ["other", "none", "normal", "bypass", "battery", "booster", "reducer"]},
        {"name": "Output frequency", "oid": UPS + "4.2.0", "scale": 0.1, "units": "hertz"},
        {"name": "Output voltage", "oid": UPS + "4.4.1.2.1", "units": "volts"},
        {"name": "Output current", "oid": UPS + "4.4.1.3.1", "scale": 0.1, "units": "amperes"},
        {"name": "Output power", "oid": UPS + "4.4.1.4.1", "units": "watts"},
        {"name": "Output load", "oid": UPS + "4.4.1.5.1", "units": "percent"},
        {"name": "Alarms present", "oid": UPS + "6.1.0"},
    ]},
}
AUTH = {"none": h.usmNoAuthProtocol, "md5": h.usmHMACMD5AuthProtocol, "sha": h.usmHMACSHAAuthProtocol,
        "sha224": h.usmHMAC128SHA224AuthProtocol, "sha256": h.usmHMAC192SHA256AuthProtocol,
        "sha384": h.usmHMAC256SHA384AuthProtocol, "sha512": h.usmHMAC384SHA512AuthProtocol}
PRIV = {"none": h.usmNoPrivProtocol, "des": h.usmDESPrivProtocol, "3des": h.usm3DESEDEPrivProtocol,
        "aes": h.usmAesCfb128Protocol, "aes128": h.usmAesCfb128Protocol, "aes192": h.usmAesCfb192Protocol,
        "aes256": h.usmAesCfb256Protocol}
NO_OBJECT = (h.NoSuchObject, h.NoSuchInstance, h.EndOfMibView)


class NoAnswer(Exception):
    pass


def norm_oid(o: str) -> str:
    o = str(o).strip().lstrip(".")
    if not OID_OK.match(o):
        raise ValueError(f"not a numeric OID: {o}")
    return o


def to_value(v: Any) -> Tuple[Optional[float], Optional[str]]:
    if isinstance(v, NO_OBJECT) or v is None:
        return None, "no such object on the device"
    if isinstance(v, h.OctetString):
        try:
            txt = bytes(v).decode("ascii").strip().rstrip("\x00")
        except UnicodeDecodeError:
            return None, "not a number (binary text)"
        return ed.finite_number(txt)
    if isinstance(v, (h.Integer, h.Integer32, h.Unsigned32, h.Gauge32, h.Counter32, h.Counter64, h.TimeTicks)):
        return int(v), None
    return None, f"not a number ({type(v).__name__})"


class Driver(ed.BaseDriver):
    def __init__(self) -> None:
        self.engine: Optional[h.SnmpEngine] = None
        self.devices: Dict[str, Dict[str, Any]] = {}
        self.targets: Dict[str, Any] = {}
        self.limiter = ed.Limiter()
        self.warnings: List[str] = []

    async def op_hello(self, req):
        return {"driver": "snmp", "version": VERSION, "scheme": SCHEME, "capabilities": ["discover", "browse", "read"]}

    async def op_configure(self, req):
        s = req.get("settings") or {}
        await self.close()
        self.engine = h.SnmpEngine()
        self.devices, self.targets, self.warnings = {}, {}, []
        w = self.warnings
        templates = {**BUILTIN, **(s.get("templates") or {})}
        for dv in s.get("devices") or []:
            try:
                name = str(dv["name"])
                if not NAME_OK.match(name):
                    raise ValueError("name may only use letters, digits, . _ -")
                key = f"{SCHEME}://{name}"
                if key in self.devices:
                    raise ValueError("name used twice")
                host = str(dv["host"])
                ver = str(dv.get("version", "2c")).lower().lstrip("v")
                if ver not in ("1", "2c", "3"):
                    raise ValueError(f"unknown SNMP version {dv.get('version')}")
                if ver == "3":
                    v3 = dv.get("v3") or {}
                    auth_p = AUTH.get(str(v3.get("auth", "sha" if v3.get("auth_key") else "none")).lower())
                    priv_p = PRIV.get(str(v3.get("priv", "aes" if v3.get("priv_key") else "none")).lower())
                    if auth_p is None or priv_p is None:
                        raise ValueError("unknown v3 auth or privacy protocol")
                    auth = h.UsmUserData(str(v3["user"]), authKey=v3.get("auth_key"), privKey=v3.get("priv_key"),
                                         authProtocol=auth_p, privProtocol=priv_p)
                    ctx = h.ContextData(contextName=str(v3.get("context", "")).encode())
                else:
                    auth = h.CommunityData(str(dv.get("community", "public")), mpModel=0 if ver == "1" else 1)
                    ctx = h.ContextData()
                raw = []
                if dv.get("template"):
                    t = templates.get(dv["template"])
                    if t is None:
                        raise ValueError(f"unknown template {dv['template']}")
                    raw += t.get("points") or []
                raw += dv.get("points") or []
                pts: Dict[str, Dict[str, Any]] = {}
                for p in raw:
                    try:
                        oid = norm_oid(p["oid"])
                        d = {"oid": oid, "name": str(p.get("name") or oid), "scale": float(p.get("scale", 1)),
                             "offset": float(p.get("offset", 0)), "units": p.get("units"),
                             "description": str(p.get("description") or ""), "kind": p.get("kind") or "number",
                             "states": p.get("states")}
                        d["key"] = f"{key}/{oid}"
                        pts[d["key"]] = d
                    except Exception as e:
                        w.append(f"{name} point {p.get('name', '?')}: {e}")
                self.devices[key] = {
                    "key": key, "name": name, "host": host, "port": int(dv.get("port", 161)), "version": ver,
                    "auth": auth, "ctx": ctx, "points": pts, "walk": [norm_oid(x) for x in dv.get("walk") or []],
                    "timeout": max(0.2, float(dv.get("timeout_ms", 1500)) / 1000), "retries": max(0, min(5, int(dv.get("retries", 2)))),
                    "max_oids": max(1, min(60, int(dv.get("max_oids", 20)))),
                }
            except Exception as e:
                w.append(f"device {dv.get('name', '?')}: {e}")
        for m in w:
            log(m)
        return {"ok": True, "devices": len(self.devices), "warnings": w}

    def _dev(self, dev):
        d = self.devices.get(dev["key"])
        if not d:
            raise DriverError("bad_request", f"{dev['key']} is not in the SNMP settings any more")
        return d

    async def _target(self, d):
        t = self.targets.get(d["key"])
        if t is None:
            try:
                t = await h.UdpTransportTarget.create((d["host"], d["port"]), timeout=d["timeout"], retries=d["retries"])
            except Exception as e:
                raise DriverError("unreachable", f"cannot resolve {d['host']} ({e})")
            self.targets[d["key"]] = t
        return t

    async def _get(self, d, oids: List[str], rate: float):
        """One GET. Returns {oid: value}; raises NoAnswer, or DriverError for refusals."""
        await self.limiter.wait(d["key"], rate)
        tgt = await self._target(d)
        try:
            ei, es, eidx, vbs = await h.get_cmd(self.engine, d["auth"], tgt, d["ctx"],
                                                *[h.ObjectType(h.ObjectIdentity(o)) for o in oids], lookupMib=False)
        except Exception as e:  # pysnmp raises for some malformed replies
            raise NoAnswer(f"bad reply ({type(e).__name__})")
        if ei:
            txt = str(ei)
            if "timed out" in txt.lower() or "timeout" in txt.lower():
                raise NoAnswer("no answer")
            # the device answers but refuses us: wrong community/user/keys, or a garbled reply
            if any(w in txt for w in ("unknownUserName", "wrongDigest", "decryption", "unsupportedSecLevel",
                                      "unknownEngineID", "notInTimeWindow", "authorization")):
                raise DriverError("rejected", f"{d['name']}: {txt}")
            raise NoAnswer(txt)
        return int(es), int(eidx), {str(vb[0]): vb[1] for vb in vbs}

    async def _read_oids(self, d, oids: List[str], rate: float) -> Dict[str, Tuple[Optional[float], Optional[str]]]:
        out: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
        size = d["max_oids"]
        queue = [oids[i:i + size] for i in range(0, len(oids), size)]
        retried = set()  # requests already asked twice after a general error
        answered, misses, dead = False, 0, None
        while queue:
            part = queue.pop(0)
            if dead:
                for o in part:
                    out[o] = (None, "no answer")
                continue
            try:
                es, eidx, vals = await self._get(d, part, rate)
            except NoAnswer as e:
                misses += 1
                if not answered or misses >= 2:
                    dead = str(e)
                for o in part:
                    out[o] = (None, "no answer")
                continue
            answered, misses = True, 0
            if es == 0:
                for o in part:
                    v = vals.get(o)
                    out[o] = to_value(v) if o in vals else (None, "missing from reply")
                continue
            if es == 1 and len(part) > 1:  # tooBig: ask for less at a time
                d["max_oids"] = size = max(1, len(part) // 2)
                queue[:0] = [part[:size], part[size:]]
                continue
            if es == 2 and 1 <= eidx <= len(part):  # v1 noSuchName: that one is missing, ask again without it
                bad = part[eidx - 1]
                out[bad] = (None, "no such object on the device")
                rest = [o for o in part if o != bad]
                if rest:
                    queue.insert(0, rest)
                continue
            if tuple(part) not in retried:  # genErr and friends are often passing: ask once more
                retried.add(tuple(part))
                queue.insert(0, part)
                continue
            if len(part) > 1:  # still refused: find the culprit one by one
                queue[:0] = [[o] for o in part]
                continue
            out[part[0]] = (None, f"device error {rfc1905.errorStatus.getNamedValues().getName(es) or es}", True)
        if not answered:
            raise DriverError("timeout", f"{d['name']}: {dead or 'no answer'}")
        return out

    async def op_discover(self, req):
        rid = req["id"]
        n = 0
        for d in self.devices.values():
            name = model = None
            try:
                vals = await asyncio.wait_for(self._read_oids(d, ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0"], 0), d["timeout"] * 3 + 1)
            except Exception:
                vals = {}
            await emit({"id": rid, "event": "device", "data": {
                "key": d["key"], "route": f"{d['host']}:{d['port']}", "name": d["name"], "vendor": None, "model": model,
                "meta": {"version": d["version"], "reachable": bool(vals)}}})
            n += 1
        return {"devices": n, "warnings": self.warnings}

    async def op_browse(self, req):
        d = self._dev(req["device"])
        rid = req["id"]
        n = 0
        for p in d["points"].values():
            await emit({"id": rid, "event": "point", "data": self._point(p)})
            n += 1
        # optional: list every number under the given subtrees (for setting up a new device type)
        for sub in d["walk"]:
            found = 0
            walker = h.walk_cmd if d["version"] == "1" else h.bulk_walk_cmd
            args = (0, 20) if walker is h.bulk_walk_cmd else ()
            try:
                async for ei, es, eidx, vbs in walker(self.engine, d["auth"], await self._target(d), d["ctx"], *args,
                                                      h.ObjectType(h.ObjectIdentity(sub)), lexicographicMode=False, lookupMib=False):
                    if ei or es:
                        break
                    for oid, v in vbs:
                        o = str(oid)
                        k = f"{d['key']}/{o}"
                        if k in d["points"] or to_value(v)[0] is None:
                            continue
                        p = {"key": k, "oid": o, "name": o, "scale": 1.0, "offset": 0.0, "units": None,
                             "description": f"found under {sub}", "kind": "number", "states": None}
                        d["points"][k] = p
                        await emit({"id": rid, "event": "point", "data": self._point(p)})
                        n += 1
                        found += 1
                    if found >= 5000:
                        break
            except Exception as e:
                await ed.warn(f"{d['name']}: listing {sub} stopped ({e})")
        return {"points": n}

    @staticmethod
    def _point(p):
        kind = p["kind"] if p["kind"] in ("number", "binary", "multistate") else "number"
        out = {"key": p["key"], "name": p["name"], "description": p["description"], "units": p["units"], "kind": kind, "cov": False}
        if p["states"]:
            out["states"] = p["states"]
        return out

    async def op_read(self, req):
        d = self._dev(req["device"])
        rate = float(req.get("rate", 5))
        keys = req["points"]
        oids = []
        for k in keys:
            p = d["points"].get(k)
            if p is None:
                try:
                    p = {"oid": norm_oid(k.split("://", 1)[1].split("/", 1)[1]), "scale": 1.0, "offset": 0.0}
                except Exception:
                    p = None
            oids.append(p["oid"] if p else None)
        res = await self._read_oids(d, sorted({o for o in oids if o}), rate)
        t = int(time.time() * 1000)
        values = []
        for k, o in zip(keys, oids):
            if not o:
                values.append({"point": k, "t": t, "v": None, "error": "not a valid SNMP point key"})
                continue
            v, err, *again = res.get(o, (None, "no answer"))
            p = d["points"].get(k) or {"scale": 1.0, "offset": 0.0}
            if v is not None and (p["scale"] != 1 or p["offset"] != 0):
                v = v * p["scale"] + p["offset"]
                v = float(format(v, ".12g"))
                if v.is_integer():
                    v = int(v)
            s = {"point": k, "t": t, "v": v}
            if err:
                s["error"] = err
                if again:
                    s["retry"] = True  # the device may well answer next time
            values.append(s)
        return {"values": values}

    async def close(self) -> None:
        if self.engine:
            try:
                self.engine.close_dispatcher()
            except Exception:
                pass
        self.engine = None


if __name__ == "__main__":
    asyncio.run(ed.run(Driver()))
