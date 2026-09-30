"""
HEAPY Edge Project Haystack driver (contract v1, see contracts/driver-protocol.json).

Reads points from Haystack servers: SkySpark, Niagara (nHaystack), FIN,
WideSky and others. Read-only: only the about, read (and formats) operations are used.
No third-party libraries.

Settings (drivers.haystack.settings):
  servers: [{name, url (e.g. https://jace-1/haystack), user, password,
             auth: auto|scram|basic|plaintext|none, filter ("point and cur"),
             verify_tls (true), tls_fingerprint, timeout_ms (15000), max_ids (200)}]

One device per server; point keys are haystack://<server>/<point id>.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sys
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import edge_driver as ed  # noqa: E402
from edge_driver import DriverError, emit, log  # noqa: E402
from http_client import HttpClient, HttpDown, HttpTimeout, TlsMismatch  # noqa: E402

ed.NAME = "haystack"
VERSION = "0.1.0"
SCHEME = "haystack"
NAME_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
REF_OK = re.compile(r"^[A-Za-z0-9_:\-.~]+$")


class NoAnswer(Exception):
    pass


# ---- Haystack JSON (v3 string prefixes and v4 _kind objects) --------------------
def hkind(v: Any) -> str:
    if isinstance(v, dict):
        return str(v.get("_kind", "dict"))
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str) and len(v) >= 2 and v[1] == ":":
        return {"m": "marker", "n": "number", "r": "ref", "s": "str", "t": "dateTime", "z": "na",
                "-": "remove", "u": "uri", "b": "bin", "c": "coord", "x": "xstr", "d": "date", "h": "time"}.get(v[0], "str")
    if v is None:
        return "null"
    return "str"


def hnum(v: Any) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    """(value, unit, error)"""
    k = hkind(v)
    if k != "number":
        return None, None, f"not a number ({k})"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f, unit = float(v), None
    elif isinstance(v, dict):
        val = v.get("val")
        if isinstance(val, str):
            f = {"INF": math.inf, "-INF": -math.inf, "NaN": math.nan}.get(val)
            if f is None:
                try:
                    f = float(val)
                except ValueError:
                    return None, None, "bad number"
        else:
            f = float(val)
        unit = v.get("unit")
    else:
        body = v[2:]
        num, _, unit = body.partition(" ")
        f = {"INF": math.inf, "-INF": -math.inf, "NaN": math.nan}.get(num)
        if f is None:
            try:
                f = float(num)
            except ValueError:
                return None, None, "bad number"
        unit = unit or None
    if not math.isfinite(f):
        return None, unit, "invalid value (NaN or infinite)"
    return (int(f) if f.is_integer() and abs(f) < 2 ** 53 else f), unit, None


def hstr(v: Any) -> Optional[str]:
    k = hkind(v)
    if isinstance(v, dict):
        return str(v.get("val")) if "val" in v else None
    if k == "str":
        return v[2:] if isinstance(v, str) and v.startswith("s:") else str(v)
    if isinstance(v, str) and len(v) >= 2 and v[1] == ":":
        return v[2:]
    return None if v is None else str(v)


def href(v: Any) -> Tuple[Optional[str], Optional[str]]:
    """(id without @, display name)"""
    if isinstance(v, dict) and v.get("_kind") == "ref":
        return str(v.get("val", "")).lstrip("@"), v.get("dis")
    if isinstance(v, str) and v.startswith("r:"):
        body = v[2:]
        ref, _, dis = body.partition(" ")
        return ref.lstrip("@"), dis or None
    if isinstance(v, str) and v.startswith("@"):
        return v[1:], None
    return None, None


def is_marker(v: Any) -> bool:
    return v is not None and hkind(v) == "marker"


def grid_rows(body: bytes) -> List[Dict[str, Any]]:
    try:
        g = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise NoAnswer("reply is not a Haystack grid")
    if not isinstance(g, dict) or not isinstance(g.get("rows", []), list):
        raise NoAnswer("reply is not a Haystack grid")
    meta = g.get("meta") or {}
    if is_marker(meta.get("err")):
        raise DriverError("rejected", f"server error: {hstr(meta.get('dis')) or 'unknown'}")
    return [r for r in g.get("rows", []) if isinstance(r, dict)]


# ---- authentication (Haystack 4 auth: SCRAM-SHA-256, PLAINTEXT, or HTTP basic) ----
def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def auth_params(header: str) -> Tuple[str, Dict[str, str]]:
    scheme, _, rest = header.strip().partition(" ")
    params = {}
    for part in rest.split(","):
        k, _, v = part.strip().partition("=")
        if k:
            params[k.strip().lower()] = v.strip()
    return scheme.upper(), params


class Server:
    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg
        self.name = cfg["name"]
        self.key = f"{SCHEME}://{self.name}"
        self.timeout = max(1.0, float(cfg.get("timeout_ms", 15000)) / 1000)
        self.http = HttpClient(str(cfg["url"]), timeout=self.timeout, verify_tls=bool(cfg.get("verify_tls", True)),
                               tls_fingerprint=str(cfg.get("tls_fingerprint", "")))
        self.user, self.password = str(cfg.get("user", "")), str(cfg.get("password", ""))
        self.mode = str(cfg.get("auth", "auto")).lower()
        self.filter = str(cfg.get("filter", "point and cur"))
        self.max_ids = max(1, min(1000, int(cfg.get("max_ids", 200))))
        self.auth_header: Optional[str] = None
        self.auth_lock = asyncio.Lock()
        self.points: Dict[str, Dict[str, Any]] = {}  # point key -> {enum}
        self.limiter = ed.Limiter()
        self.rate = 2.0  # every request counts, logins included

    async def _send(self, method, path, body=None, ctype=None, auth=None):
        h = {"Accept": "application/json"}
        if ctype:
            h["Content-Type"] = ctype
        a = auth if auth is not None else self.auth_header
        if a:
            h["Authorization"] = a
        await self.limiter.wait(self.key, self.rate)
        try:
            return await self.http.request(method, path, body, h)
        except HttpDown as e:
            raise DriverError("unreachable", str(e))
        except TlsMismatch as e:
            raise DriverError("rejected", f"{self.name}: {e}")
        except HttpTimeout as e:
            raise NoAnswer(str(e))

    async def login(self) -> None:
        async with self.auth_lock:
            await self._login()

    async def _login(self) -> None:
        mode = self.mode
        if mode == "none":
            self.auth_header = ""
            return
        if mode == "basic":
            self.auth_header = "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            return
        r = await self._send("GET", "/about", auth=f"HELLO username={b64u(self.user.encode())}")
        if r.status == 200 and mode == "auto":
            self.auth_header = ""  # server needs no login
            return
        www = r.header("www-authenticate")
        scheme, p = auth_params(www) if www else ("", {})
        if mode == "auto":
            if scheme == "BASIC" or (r.status == 401 and not www):
                self.auth_header = "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
                return
            mode = scheme.lower()
        if mode == "plaintext":
            hdr = f"PLAINTEXT username={b64u(self.user.encode())}, password={b64u(self.password.encode())}"
            r = await self._send("GET", "/about", auth=hdr)
            self._take_token(r)
            return
        if mode != "scram":
            raise DriverError("rejected", f"{self.name}: unsupported login method '{scheme or r.status}'")
        hs = p.get("handshaketoken", "")
        algo = p.get("hash", "SHA-256").upper().replace("-", "")
        hname = {"SHA256": "sha256", "SHA512": "sha512", "SHA1": "sha1"}.get(algo)
        if not hname:
            raise DriverError("rejected", f"{self.name}: unsupported SCRAM hash {algo}")
        cnonce = b64u(secrets.token_bytes(18))
        c1_bare = f"n={self.user},r={cnonce}"
        r = await self._send("GET", "/about", auth=f"SCRAM handshakeToken={hs}, data={b64u(('n,,' + c1_bare).encode())}")
        if r.status != 401:
            raise DriverError("rejected", f"{self.name}: login failed (HTTP {r.status})")
        _, p2 = auth_params(r.header("www-authenticate"))
        s1 = unb64u(p2.get("data", "")).decode()
        f = dict(x.split("=", 1) for x in s1.split(",") if "=" in x)
        nonce, salt, iters = f.get("r", ""), base64.b64decode(f.get("s", "")), int(f.get("i", "0"))
        if not nonce.startswith(cnonce) or iters < 1:
            raise DriverError("rejected", f"{self.name}: login failed (bad SCRAM reply)")
        salted = hashlib.pbkdf2_hmac(hname, self.password.encode(), salt, iters)
        ckey = hmac.new(salted, b"Client Key", hname).digest()
        stored = hashlib.new(hname, ckey).digest()
        c2_wo = f"c=biws,r={nonce}"
        amsg = f"{c1_bare},{s1},{c2_wo}".encode()
        csig = hmac.new(stored, amsg, hname).digest()
        proof = bytes(a ^ b for a, b in zip(ckey, csig))
        c2 = f"{c2_wo},p={base64.b64encode(proof).decode()}"
        r = await self._send("GET", "/about", auth=f"SCRAM handshakeToken={p2.get('handshaketoken', hs)}, data={b64u(c2.encode())}")
        if r.status != 200:
            raise DriverError("rejected", f"{self.name}: user name or password refused (HTTP {r.status})")
        info = r.header("authentication-info")
        _, p3 = auth_params("X " + info)
        s2 = unb64u(p3.get("data", "")).decode() if p3.get("data") else ""
        skey = hmac.new(salted, b"Server Key", hname).digest()
        want = base64.b64encode(hmac.new(skey, amsg, hname).digest()).decode()
        if s2 and s2 != f"v={want}":
            raise DriverError("rejected", f"{self.name}: server failed to prove its identity")
        self._take_token(r)

    def _take_token(self, r) -> None:
        if r.status != 200:
            raise DriverError("rejected", f"{self.name}: user name or password refused (HTTP {r.status})")
        _, p = auth_params("X " + r.header("authentication-info"))
        tok = p.get("authtoken")
        if not tok:
            raise DriverError("rejected", f"{self.name}: login gave no token")
        self.auth_header = f"BEARER authToken={tok}"

    async def call(self, method, path, body=None, ctype=None):
        """A request with login as needed; a refused token is renewed once."""
        if self.auth_header is None:
            await self.login()
        for attempt in (0, 1):
            before = self.auth_header
            r = await self._send(method, path, body, ctype)
            if r.status in (401, 403) and attempt == 0:
                async with self.auth_lock:
                    if self.auth_header == before:  # nobody renewed it meanwhile
                        self.auth_header = None
                        await self._login()
                continue
            if r.status in (401, 403):
                raise DriverError("rejected", f"{self.name}: access refused (HTTP {r.status})")
            if r.status in (429, 503):
                await asyncio.sleep(1.0)
                raise NoAnswer(f"server busy (HTTP {r.status})")
            if r.status >= 500 and not r.body.lstrip().startswith(b"{"):
                raise NoAnswer(f"server error (HTTP {r.status})")
            if r.status == 404:
                raise DriverError("rejected", f"{self.name}: {path.split('?')[0]} not found (check the address)")
            return grid_rows(r.body)
        raise NoAnswer("no answer")


class Driver(ed.BaseDriver):
    def __init__(self) -> None:
        self.servers: Dict[str, Server] = {}
        self.limiter = ed.Limiter()
        self.warnings: List[str] = []

    async def op_hello(self, req):
        return {"driver": "haystack", "version": VERSION, "scheme": SCHEME, "capabilities": ["discover", "browse", "read"]}

    async def op_configure(self, req):
        s = req.get("settings") or {}
        await self.close()
        self.servers, self.warnings = {}, []
        for c in s.get("servers") or []:
            try:
                name = str(c["name"])
                if not NAME_OK.match(name):
                    raise ValueError("name may only use letters, digits, . _ -")
                if f"{SCHEME}://{name}" in self.servers:
                    raise ValueError("name used twice")
                srv = Server(c)
                if not srv.http.verify and not srv.http.fp and srv.http.scheme == "https":
                    self.warnings.append(f"{name}: certificate checks are off (set tls_fingerprint to pin it instead)")
                self.servers[srv.key] = srv
            except Exception as e:
                self.warnings.append(f"server {c.get('name', '?')}: {e}")
        for m in self.warnings:
            log(m)
        return {"ok": True, "servers": len(self.servers), "warnings": self.warnings}

    def _srv(self, dev) -> Server:
        s = self.servers.get(dev["key"])
        if not s:
            raise DriverError("bad_request", f"{dev['key']} is not in the Haystack settings any more")
        return s

    async def op_discover(self, req):
        rid = req["id"]
        n = 0
        for s in self.servers.values():
            vendor = model = None
            meta: Dict[str, Any] = {}
            try:
                rows = await s.call("GET", "/about")
                a = rows[0] if rows else {}
                vendor = hstr(a.get("vendorName"))
                model = " ".join(x for x in (hstr(a.get("productName")), hstr(a.get("productVersion"))) if x) or None
                meta["server_name"] = hstr(a.get("serverName"))
            except (DriverError, NoAnswer) as e:
                meta["error"] = str(e)
            await emit({"id": rid, "event": "device", "data": {
                "key": s.key, "route": s.cfg["url"], "name": s.name, "vendor": vendor, "model": model, "meta": meta}})
            n += 1
        return {"devices": n, "warnings": self.warnings}

    async def op_browse(self, req):
        s = self._srv(req["device"])
        rid = req["id"]
        s.rate = float(req.get("rate", s.rate))
        try:
            rows = await s.call("GET", "/read?filter=" + quote(s.filter, safe=""))
        except NoAnswer as e:
            raise DriverError("timeout", f"{s.name}: {e}")
        n = 0
        for r in rows:
            pid, dis = href(r.get("id"))
            if not pid or not REF_OK.match(pid):
                continue
            kind_tag = (hstr(r.get("kind")) or "Number").lower()
            enum = [x.strip() for x in (hstr(r.get("enum")) or "").split(",") if x.strip()]
            kind = "binary" if kind_tag == "bool" else "multistate" if kind_tag == "str" else "number"
            unit = hstr(r.get("unit"))
            if not unit:
                _, unit, _ = hnum(r.get("curVal"))
            equip = href(r.get("equipRef"))[1]
            name = dis or hstr(r.get("dis")) or hstr(r.get("navName")) or pid
            key = f"{s.key}/{pid}"
            s.points[key] = {"enum": enum}
            p = {"key": key, "name": name, "description": " / ".join(x for x in (equip, hstr(r.get("navName"))) if x),
                 "units": unit, "kind": kind, "cov": False}
            if kind == "binary":
                p["states"] = ["false", "true"]
            elif enum:
                p["states"] = enum
            await emit({"id": rid, "event": "point", "data": p})
            n += 1
        return {"points": n}

    async def op_read(self, req):
        s = self._srv(req["device"])
        s.rate = float(req.get("rate", s.rate))
        keys = req["points"]
        ids = []
        for k in keys:
            pid = k.split("://", 1)[1].split("/", 1)[1] if "/" in k.split("://", 1)[-1] else ""
            ids.append(pid if REF_OK.match(pid or "-") and pid else None)
        want = sorted({i for i in ids if i})
        res: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
        answered, misses, dead = False, 0, None
        for i in range(0, len(want), s.max_ids):
            part = want[i:i + s.max_ids]
            if dead:
                for pid in part:
                    res[pid] = (None, "no answer")
                continue
            body = ("ver:\"3.0\"\nid\n" + "\n".join("@" + x for x in part) + "\n").encode()
            try:
                rows = await s.call("POST", "/read", body, "text/zinc; charset=utf-8")
            except NoAnswer as e:
                misses += 1
                if not answered or misses >= 2:
                    dead = str(e)
                for pid in part:
                    res[pid] = (None, "no answer")
                continue
            answered, misses = True, 0
            got = {}
            for r in rows:
                pid, _ = href(r.get("id"))
                if pid:
                    got[pid] = r
            for pid in part:
                r = got.get(pid)
                if r is None or len([k for k in r if r.get(k) is not None]) <= 1:
                    res[pid] = (None, "unknown point id on the server")
                    continue
                res[pid] = self._value(s, f"{s.key}/{pid}", r)
        if not answered:
            raise DriverError("timeout", f"{s.name}: {dead or 'no answer'}")
        t = int(time.time() * 1000)
        values = []
        for k, pid in zip(keys, ids):
            if not pid:
                values.append({"point": k, "t": t, "v": None, "error": "not a valid Haystack point key"})
                continue
            v, err = res.get(pid, (None, "no answer"))
            sm = {"point": k, "t": t, "v": v}
            if err:
                sm["error"] = err
            values.append(sm)
        return {"values": values}

    @staticmethod
    def _value(s: Server, key: str, r: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
        st = hstr(r.get("curStatus"))
        if st and st != "ok":
            return None, f"point status {st}"
        cv = r.get("curVal")
        if cv is None:
            return None, "no current value"
        k = hkind(cv)
        if k == "bool":
            return (1 if cv else 0), None
        if isinstance(cv, dict) and cv.get("_kind") == "bool":
            return (1 if cv.get("val") else 0), None
        if k == "number":
            v, _, err = hnum(cv)
            return v, err
        if k == "na":
            return None, "not available"
        txt = hstr(cv)
        enum = (s.points.get(key) or {}).get("enum") or []
        if txt in enum:
            return enum.index(txt), None
        v, err = ed.finite_number(txt)
        return (v, None) if err is None else (None, f"not a number ({(txt or '')[:30]})")

    async def close(self) -> None:
        for s in self.servers.values():
            s.http.close()


if __name__ == "__main__":
    asyncio.run(ed.run(Driver()))
