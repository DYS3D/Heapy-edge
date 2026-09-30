"""
HEAPY Edge oBIX driver (contract v1, see contracts/driver-protocol.json).

Reads points from Niagara stations (JACE / Supervisor) and other oBIX 1.0 servers.
Read-only: only GET and the oBIX batch Read operation are used (never Write/invoke).
No third-party libraries.

Settings (drivers.obix.settings):
  stations: [{name, url (e.g. https://jace-1/obix), user, password,
              roots (["config/Drivers/"]), max_depth (10), max_points (20000),
              verify_tls (true), tls_fingerprint, timeout_ms (15000), batch (100)}]

On a Niagara station the user needs HTTP Basic authentication allowed and read
access to the points. One device per station; point keys are
obix://<station>/<path under /obix/>.
"""

from __future__ import annotations

import asyncio
import base64
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import edge_driver as ed  # noqa: E402
from edge_driver import DriverError, emit, log  # noqa: E402
from http_client import HttpClient, HttpDown, HttpTimeout, TlsMismatch  # noqa: E402

ed.NAME = "obix"
VERSION = "0.1.0"
SCHEME = "obix"
NAME_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
PATH_OK = re.compile(r"^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$")
VALUE_TAGS = {"real", "int", "bool", "enum"}
POINT_HINTS = ("NumericPoint", "BooleanPoint", "EnumPoint", "NumericWritable", "BooleanWritable", "EnumWritable",
               "StatusNumeric", "StatusBoolean", "StatusEnum")
BAD_STATUS = {"fault", "down", "disabled", "stale", "null"}
ERR_STATUS = {"unknown"}


class NoAnswer(Exception):
    pass


def tag(el) -> str:
    return el.tag.split("}", 1)[-1]


def parse(body: bytes):
    if b"<!DOCTYPE" in body[:2000] or b"<!ENTITY" in body[:4000]:
        raise NoAnswer("reply has a DOCTYPE (refused)")
    try:
        return ET.fromstring(body)
    except ET.ParseError:
        raise NoAnswer("reply is not oBIX XML")


def unit_name(u: Optional[str]) -> Optional[str]:
    if not u:
        return None
    return u.rsplit("/", 1)[-1] or None


def value_of(el, states: Optional[List[str]]) -> Tuple[Optional[float], Optional[str]]:
    t = tag(el)
    if t == "err":
        return None, f"server error: {el.get('display') or el.get('is') or 'unknown'}"
    st = (el.get("status") or "ok").lower()
    if st in BAD_STATUS:
        return None, f"point status {st}"
    if el.get("null") == "true":
        return None, "no current value"
    v = el.get("val")
    if v is None:
        return None, "no current value"
    if t == "bool":
        return (1 if v.lower() == "true" else 0), None
    if t == "enum":
        if states and v in states:
            return states.index(v), None
        return ed.finite_number(v) if re.match(r"^-?\d+$", v) else (None, f"unknown state {v[:30]}")
    num, err = ed.finite_number(v)
    if err:
        return None, err if "invalid" in err else "not a number"
    if isinstance(num, float):
        num = float(format(num, ".10g"))
    return num, None


class Station:
    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg
        self.name = cfg["name"]
        self.key = f"{SCHEME}://{self.name}"
        url = str(cfg["url"]).rstrip("/") + "/"
        self.base = url
        self.base_path = urlsplit(url).path  # e.g. /obix/
        self.timeout = max(1.0, float(cfg.get("timeout_ms", 15000)) / 1000)
        self.http = HttpClient(url.split(self.base_path, 1)[0] if self.base_path != "/" else url.rstrip("/"),
                               timeout=self.timeout, verify_tls=bool(cfg.get("verify_tls", True)),
                               tls_fingerprint=str(cfg.get("tls_fingerprint", "")))
        user, pw = str(cfg.get("user", "")), str(cfg.get("password", ""))
        self.auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode() if user else ""
        self.roots = [str(r).lstrip("/") for r in cfg.get("roots") or ["config/Drivers/"]]
        self.max_depth = max(1, min(30, int(cfg.get("max_depth", 10))))
        self.max_points = max(1, int(cfg.get("max_points", 20000)))
        self.batch = max(1, min(500, int(cfg.get("batch", 100))))
        self.batch_path: Optional[str] = None
        self.states: Dict[str, List[str]] = {}  # point path -> enum state names
        self.limiter = ed.Limiter()
        self.rate = 2.0  # every request counts

    def path_of(self, href: str, parent: str) -> Optional[str]:
        """Absolute path under the oBIX base, or None if it points elsewhere."""
        full = urlsplit(urljoin(parent, href)).path
        if not full.startswith(self.base_path):
            return None
        return full[len(self.base_path):]

    async def _get_once(self, path: str, method="GET", body=None):
        h = {"Accept": "text/xml"}
        if self.auth:
            h["Authorization"] = self.auth
        if body is not None:
            h["Content-Type"] = "text/xml; charset=utf-8"
        await self.limiter.wait(self.key, self.rate)
        try:
            r = await self.http.request(method, self.base_path + path, body, h)
        except HttpDown as e:
            raise DriverError("unreachable", str(e))
        except TlsMismatch as e:
            raise DriverError("rejected", f"{self.name}: {e}")
        except HttpTimeout as e:
            raise NoAnswer(str(e))
        if r.status in (401, 403):
            raise DriverError("rejected", f"{self.name}: access refused (HTTP {r.status}); check the user and that HTTP Basic is allowed")
        if r.status in (429, 503):
            await asyncio.sleep(1.0)
            raise NoAnswer(f"station busy (HTTP {r.status})")
        if r.status >= 500:
            raise NoAnswer(f"station error (HTTP {r.status})")
        if r.status == 404:
            raise DriverError("rejected", f"{self.name}: {path} not found")
        if r.status != 200:
            raise NoAnswer(f"HTTP {r.status}")
        return parse(r.body)

    async def get(self, *a, **k):
        """Quick failures (server error, busy, garbled reply, dropped connection) are asked
        again at once, up to twice; a real timeout is not (it already cost the full wait)."""
        for attempt in range(3):
            try:
                return await self._get_once(*a, **k)
            except NoAnswer as e:
                slow = str(e).startswith(("no answer", "no complete answer"))
                if slow or attempt == 2:
                    raise
                await asyncio.sleep(0.3 * (attempt + 1))

    async def find_batch(self) -> str:
        if self.batch_path is None:
            lobby = await self.get("")
            href = None
            for el in lobby.iter():
                if tag(el) == "op" and el.get("name") == "batch":
                    href = el.get("href")
            p = self.path_of(href, self.base) if href else None
            self.batch_path = p or "batch/"
        return self.batch_path


class Driver(ed.BaseDriver):
    def __init__(self) -> None:
        self.stations: Dict[str, Station] = {}
        self.limiter = ed.Limiter()
        self.warnings: List[str] = []

    async def op_hello(self, req):
        return {"driver": "obix", "version": VERSION, "scheme": SCHEME, "capabilities": ["discover", "browse", "read"]}

    async def op_configure(self, req):
        s = req.get("settings") or {}
        await self.close()
        self.stations, self.warnings = {}, []
        for c in s.get("stations") or []:
            try:
                name = str(c["name"])
                if not NAME_OK.match(name):
                    raise ValueError("name may only use letters, digits, . _ -")
                if f"{SCHEME}://{name}" in self.stations:
                    raise ValueError("name used twice")
                st = Station(c)
                if st.http.scheme == "https" and not st.http.verify and not st.http.fp:
                    self.warnings.append(f"{name}: certificate checks are off (set tls_fingerprint to pin it instead)")
                if st.http.scheme == "http" and st.auth:
                    self.warnings.append(f"{name}: password sent without encryption (use https)")
                self.stations[st.key] = st
            except Exception as e:
                self.warnings.append(f"station {c.get('name', '?')}: {e}")
        for m in self.warnings:
            log(m)
        return {"ok": True, "stations": len(self.stations), "warnings": self.warnings}

    def _st(self, dev) -> Station:
        s = self.stations.get(dev["key"])
        if not s:
            raise DriverError("bad_request", f"{dev['key']} is not in the oBIX settings any more")
        return s

    async def op_discover(self, req):
        rid = req["id"]
        n = 0
        for s in self.stations.values():
            meta: Dict[str, Any] = {}
            vendor = model = None
            try:
                about = await s.get("about/")
                vals = {c.get("name"): c.get("val") for c in about}
                vendor = vals.get("vendorName")
                model = " ".join(x for x in (vals.get("productName"), vals.get("productVersion")) if x) or None
                meta["server_name"] = vals.get("serverName")
            except (DriverError, NoAnswer) as e:
                meta["error"] = str(e)
            await emit({"id": rid, "event": "device", "data": {
                "key": s.key, "route": s.cfg["url"], "name": s.name, "vendor": vendor, "model": model, "meta": meta}})
            n += 1
        return {"devices": n, "warnings": self.warnings}

    async def op_browse(self, req):
        s = self._st(req["device"])
        rid = req["id"]
        s.rate = float(req.get("rate", s.rate))
        found: Dict[str, Dict[str, Any]] = {}
        seen = set()
        queue: List[Tuple[str, int]] = [(r, 0) for r in s.roots]
        while queue and len(found) < s.max_points:
            path, depth = queue.pop(0)
            if path in seen:
                continue
            seen.add(path)
            try:
                obj = await s.get(path)
            except NoAnswer as e:
                await ed.warn(f"{s.name}: could not list {path} ({e})")
                continue
            here = s.base + path
            if tag(obj) in VALUE_TAGS and obj.get("val") is not None:
                found.setdefault(path, {"el": obj})
            for ch in obj:
                href = ch.get("href")
                if not href:
                    continue
                p = s.path_of(href, here)
                if not p or p in seen or not PATH_OK.match(p):
                    continue
                t = tag(ch)
                if t in VALUE_TAGS and ch.get("val") is not None:
                    found.setdefault(p, {"el": ch})
                elif t == "ref" and any(hn in (ch.get("is") or "") for hn in POINT_HINTS):
                    found.setdefault(p, {"el": None})
                elif t in ("ref", "obj") and depth + 1 < s.max_depth:
                    queue.append((p, depth + 1))
        # fetch the point objects we only know by reference (units, type, enum range) in batches
        todo = [p for p, f in found.items() if f["el"] is None]
        for i in range(0, len(todo), s.batch):
            part = todo[i:i + s.batch]
            try:
                out = await self._batch(s, part)
            except NoAnswer as e:
                await ed.warn(f"{s.name}: could not read point details ({e})")
                continue
            for p, el in zip(part, out):
                if el is not None and tag(el) != "err":
                    found[p]["el"] = el
        n = 0
        for p, f in found.items():
            el = f["el"]
            if el is None or tag(el) not in VALUE_TAGS:
                continue
            t = tag(el)
            if t == "enum" and el.get("range"):
                rp = s.path_of(el.get("range"), s.base + p)
                if rp:
                    try:
                        rng = await s.get(rp)
                        s.states[p] = [c.get("name") for c in rng if c.get("name")]
                    except (NoAnswer, DriverError):
                        pass
            key = f"{s.key}/{p.rstrip('/')}"
            kind = {"bool": "binary", "enum": "multistate"}.get(t, "number")
            pt = {"key": key, "name": el.get("displayName") or el.get("name") or p.rstrip("/").rsplit("/", 1)[-1],
                  "description": p.rstrip("/"), "units": unit_name(el.get("unit")), "kind": kind, "cov": False}
            if kind == "binary":
                pt["states"] = [el.get("falseText") or "false", el.get("trueText") or "true"]
            elif s.states.get(p):
                pt["states"] = s.states[p]
            await emit({"id": rid, "event": "point", "data": pt})
            n += 1
        return {"points": n}

    async def _batch(self, s: Station, paths: List[str]) -> List[Optional[Any]]:
        bp = await s.find_batch()
        body = ('<list is="obix:BatchIn" xmlns="http://obix.org/ns/schema/1.0">'
                + "".join(f'<uri is="obix:Read" val="{s.base_path}{p}"/>' for p in paths) + "</list>").encode()
        out = await s.get(bp, "POST", body)
        items = list(out)
        if tag(out) == "err":
            raise NoAnswer(f"batch refused: {out.get('display') or ''}")
        if len(items) != len(paths):
            raise NoAnswer(f"batch reply has {len(items)} items for {len(paths)} requests")
        return items

    async def op_read(self, req):
        s = self._st(req["device"])
        s.rate = float(req.get("rate", s.rate))
        keys = req["points"]
        paths = []
        for k in keys:
            rest = k.split("://", 1)[-1]
            p = rest.split("/", 1)[1] + "/" if "/" in rest else ""
            paths.append(p if p and PATH_OK.match(p) and ".." not in p else None)
        want = list(dict.fromkeys(p for p in paths if p))
        res: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
        answered, misses, dead = False, 0, None
        for i in range(0, len(want), s.batch):
            part = want[i:i + s.batch]
            if dead:
                for p in part:
                    res[p] = (None, "no answer")
                continue
            try:
                items = await self._batch(s, part)
            except NoAnswer as e:
                misses += 1
                if not answered or misses >= 2:
                    dead = str(e)
                for p in part:
                    res[p] = (None, "no answer")
                continue
            answered, misses = True, 0
            for p, el in zip(part, items):
                res[p] = value_of(el, s.states.get(p))
        if not answered:
            raise DriverError("timeout", f"{s.name}: {dead or 'no answer'}")
        t = int(time.time() * 1000)
        values = []
        for k, p in zip(keys, paths):
            if not p:
                values.append({"point": k, "t": t, "v": None, "error": "not a valid oBIX point key"})
                continue
            v, err = res.get(p, (None, "no answer"))
            sm = {"point": k, "t": t, "v": v}
            if err:
                sm["error"] = err
            values.append(sm)
        return {"values": values}

    async def close(self) -> None:
        for s in self.stations.values():
            s.http.close()


if __name__ == "__main__":
    asyncio.run(ed.run(Driver()))
