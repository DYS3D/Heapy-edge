"""
HEAPY Edge - simulated Project Haystack servers for testing and stress testing.

Each server (own IP, HTTP port 80) serves /about and /read with Haystack JSON
(v3 string encoding or v4 _kind objects), and logs in with SCRAM-SHA-256
(Haystack 4 auth), HTTP basic, or no login. Every server has the same equips
and points (POINTS below) so the tests know what each point must read.

  ip netns exec bas-hs python3 haystack_sim.py --base 10.78.6. --servers 3 --control /tmp/hs.sock

Control socket (JSON lines): {"cmd":"fault","dev":"hs-01","f":"err500","v":0.1,"on":true}
  faults: offline (no packets), slow (v = s), err500, garbage, drop (connection closed
  without a reply), busy (429), hang (never answers), expire (every login token
  stops working now), status (v = point id: curStatus fault), remove (v = point id)
  {"cmd":"stats"}
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
import hashlib
import hmac
import json
import math
import os
import random
import secrets
import signal
import subprocess
import time
from urllib.parse import parse_qs, unquote, urlsplit

T0 = time.time()
USER, PASSWORD = "heapy", "lab-Password-1"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# (id suffix, dis, kind, unit, curVal or "dyn:*", extra tags, expected reading)
POINTS = []
for e in range(1, 5):
    eq = f"ahu{e}"
    POINTS += [
        (f"{eq}.sat", f"AHU-{e} Supply Temp", "Number", "°F", 55.5 + e, {}, 55.5 + e),
        (f"{eq}.rat", f"AHU-{e} Return Temp", "Number", "°F", "dyn:wave", {}, "range:68:76"),
        (f"{eq}.fan", f"AHU-{e} Fan Status", "Bool", None, e % 2 == 1, {}, int(e % 2 == 1)),
        (f"{eq}.mode", f"AHU-{e} Mode", "Str", None, "cool", {"enum": "off,heat,cool,auto"}, 2),
        (f"{eq}.cfm", f"AHU-{e} Airflow", "Number", "cfm", 12000 + e, {}, 12000 + e),
        (f"{eq}.damper", f"AHU-{e} OA Damper", "Number", "%", 25.25, {}, 25.25),
    ]
POINTS += [
    ("plant.kw", "Plant Power", "Number", "kW", "dyn:counter", {}, "any"),
    ("plant.bad", "Plant Sensor Fault", "Number", "°F", 0, {"curStatus": "fault"}, None),
    ("plant.nan", "Plant NaN", "Number", "°F", "n:NaN", {}, None),
    ("plant.noval", "Plant No Value", "Number", "°F", None, {}, None),
    ("plant.textnum", "Plant Text Number", "Str", None, "42.5", {}, 42.5),
    ("plant.neg", "Plant Negative", "Number", "°F", -12.75, {}, -12.75),
]
EXPECTED = {p[1]: p[6] for p in POINTS}


class HServer:
    def __init__(self, name, ip, fmt, auth):
        self.name, self.ip, self.fmt, self.auth = name, ip, fmt, auth
        self.faults = {}
        self.tokens = set()
        self.handshakes = {}
        self.salt = secrets.token_bytes(16)
        self.iters = 4096
        self.stats = {"requests": 0, "reads": 0, "logins": 0, "max_rate": 0, "max_conns": 0}
        self._win = []
        self.conns = 0
        self.status_fault, self.removed = set(), set()

    def roll(self, k):
        v = self.faults.get(k)
        return bool(v) and random.random() < float(v)

    # ---- encoding
    def enc(self, kind, v, unit=None):
        if self.fmt == "v4":
            if kind == "marker":
                return {"_kind": "marker"}
            if kind == "ref":
                return {"_kind": "ref", "val": v[0], "dis": v[1]}
            if kind == "number":
                if isinstance(v, str):
                    return {"_kind": "number", "val": v[2:], **({"unit": unit} if unit else {})}
                return {"_kind": "number", "val": v, **({"unit": unit} if unit else {})} if unit else v
            if kind == "bool":
                return v
            return v
        if kind == "marker":
            return "m:"
        if kind == "ref":
            return f"r:{v[0]} {v[1]}"
        if kind == "number":
            if isinstance(v, str):
                return v
            return f"n:{v}" + (f" {unit}" if unit else "")
        if kind == "bool":
            return v
        return f"s:{v}"

    def cur(self, p):
        v = p[4]
        if isinstance(v, str) and v.startswith("dyn:"):
            now = time.time()
            v = {"dyn:wave": round(72 + 3 * math.sin((now - T0) / 30), 2), "dyn:counter": round((now - T0) * 1.5, 1)}[v]
        return v

    def row(self, p, full=True):
        pid = f"p:{self.name}:{p[0]}"
        if p[0] in self.removed:
            return {"id": self.enc("ref", (pid, p[1]))}
        r = {"id": self.enc("ref", (pid, p[1])), "dis": self.enc("str", p[1]), "point": self.enc("marker", None),
             "cur": self.enc("marker", None), "kind": self.enc("str", p[2]),
             "equipRef": self.enc("ref", (f"e:{self.name}:{p[0].split('.')[0]}", p[0].split('.')[0].upper()))}
        if p[3]:
            r["unit"] = self.enc("str", p[3])
        for k, v in p[5].items():
            r[k] = self.enc("str", v)
        status = "fault" if p[0] in self.status_fault else p[5].get("curStatus", "ok")
        r["curStatus"] = self.enc("str", status)
        v = self.cur(p)
        if v is not None:
            if p[2] == "Number":
                r["curVal"] = self.enc("number", v, p[3])
            elif p[2] == "Bool":
                r["curVal"] = self.enc("bool", v)
            else:
                r["curVal"] = self.enc("str", v)
        return r

    def grid(self, rows):
        cols = sorted({k for r in rows for k in r})
        g = {"meta": {"ver": "3.0"}, "cols": [{"name": c} for c in cols], "rows": rows}
        if self.fmt == "v4":
            g["_kind"] = "grid"
        return json.dumps(g).encode()

    # ---- HTTP
    async def handle(self, reader, writer):
        self.conns += 1
        self.stats["max_conns"] = max(self.stats["max_conns"], self.conns)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                method, target, _ = line.decode("latin-1").split(" ", 2)
                hdrs = {}
                while True:
                    h = await reader.readline()
                    if h in (b"\r\n", b"\n", b""):
                        break
                    k, _, v = h.decode("latin-1").partition(":")
                    hdrs[k.strip().lower()] = v.strip()
                body = await reader.readexactly(int(hdrs.get("content-length", "0") or 0))
                now = time.monotonic()
                self._win = [t for t in self._win if now - t < 1] + [now]
                self.stats["max_rate"] = max(self.stats["max_rate"], len(self._win))
                self.stats["requests"] += 1
                if self.faults.get("hang"):
                    while await reader.read(1024):  # never answer; stop when the client gives up
                        pass
                    break
                if self.roll("drop"):
                    break
                await asyncio.sleep(0.003 + float(self.faults.get("slow") or 0))
                status, extra, out = self.route(method, target, hdrs, body)
                if self.roll("garbage"):
                    status, out = 200, b'{"meta": {"ver": "3.0"}, "rows": [{"id": "r:x' + bytes(random.randrange(32, 127) for _ in range(20))
                if self.roll("err500"):
                    status, out = 500, b"<html>Internal error</html>"
                if self.roll("busy"):
                    status, out = 429, b"busy"
                head = f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len(out)}\r\n"
                for k, v in extra.items():
                    head += f"{k}: {v}\r\n"
                writer.write((head + "\r\n").encode() + out)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self.conns -= 1
            try:
                writer.close()
            except Exception:
                pass

    def check_auth(self, hdrs):
        a = hdrs.get("authorization", "")
        if self.auth == "none":
            return True, None
        if self.auth == "basic":
            ok = a == "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
            return ok, None if ok else (401, {"WWW-Authenticate": 'Basic realm="lab"'}, b"")
        if a.upper().startswith("BEARER"):
            tok = a.split("authToken=", 1)[-1].strip()
            if tok in self.tokens:
                return True, None
            return False, (403, {}, b"")
        if a.upper().startswith("HELLO"):
            hs = secrets.token_hex(8)
            self.handshakes[hs] = {}
            return False, (401, {"WWW-Authenticate": f"SCRAM handshakeToken={hs}, hash=SHA-256"}, b"")
        if a.upper().startswith("SCRAM"):
            p = dict((kv.strip().split("=", 1)) for kv in a[6:].split(",") if "=" in kv)
            hs, data = p.get("handshakeToken", ""), unb64u(p.get("data", "")).decode()
            st = self.handshakes.get(hs)
            if st is None:
                return False, (403, {}, b"")
            if "c1" not in st:
                bare = data.split(",", 2)[2]
                f = dict(x.split("=", 1) for x in bare.split(","))
                if f.get("n") != USER:
                    return False, (403, {}, b"")
                nonce = f["r"] + b64u(secrets.token_bytes(12))
                s1 = f"r={nonce},s={base64.b64encode(self.salt).decode()},i={self.iters}"
                st.update(c1=bare, s1=s1, nonce=nonce)
                return False, (401, {"WWW-Authenticate": f"SCRAM handshakeToken={hs}, hash=SHA-256, data={b64u(s1.encode())}"}, b"")
            wo, _, proof = data.rpartition(",p=")
            if f"r={st['nonce']}" not in wo:
                return False, (403, {}, b"")
            salted = hashlib.pbkdf2_hmac("sha256", PASSWORD.encode(), self.salt, self.iters)
            ckey = hmac.new(salted, b"Client Key", "sha256").digest()
            amsg = f"{st['c1']},{st['s1']},{wo}".encode()
            csig = hmac.new(hashlib.sha256(ckey).digest(), amsg, "sha256").digest()
            got = bytes(a ^ b for a, b in zip(base64.b64decode(proof), csig))
            del self.handshakes[hs]
            if got != ckey:
                return False, (403, {}, b"")
            tok = secrets.token_hex(16)
            self.tokens.add(tok)
            self.stats["logins"] += 1
            ssig = hmac.new(hmac.new(salted, b"Server Key", "sha256").digest(), amsg, "sha256").digest()
            s2 = f"v={base64.b64encode(ssig).decode()}"
            return False, (200, {"Authentication-Info": f"authToken={tok}, data={b64u(s2.encode())}"}, self.about())
        return False, (401, {}, b"")

    def about(self):
        return self.grid([{"serverName": self.enc("str", self.name), "vendorName": self.enc("str", "HEAPY Lab"),
                           "productName": self.enc("str", "Haystack Sim"), "productVersion": self.enc("str", "1.0")}])

    def route(self, method, target, hdrs, body):
        ok, deny = self.check_auth(hdrs)
        if not ok:
            return deny
        u = urlsplit(target)
        path = u.path
        if path.endswith("/about"):
            return 200, {}, self.about()
        if path.endswith("/read"):
            self.stats["reads"] += 1
            if method == "GET":
                return 200, {}, self.grid([self.row(p) for p in POINTS])
            txt = body.decode()
            ids = [ln.strip()[1:] for ln in txt.splitlines()[2:] if ln.strip().startswith("@")]
            by = {f"p:{self.name}:{p[0]}": p for p in POINTS}
            rows = [self.row(by[i]) if i in by else {"id": self.enc("ref", (i, i))} for i in ids]
            return 200, {}, self.grid(rows)
        return 404, {}, b""


def fw(args):
    subprocess.run(["iptables"] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="10.78.6.")
    ap.add_argument("--first", type=int, default=10)
    ap.add_argument("--servers", type=int, default=3)
    ap.add_argument("--control", default="")
    ap.add_argument("--print-expected", action="store_true")
    ap.add_argument("--tls", action="store_true", help="also serve HTTPS on 443 with a self-signed certificate")
    a = ap.parse_args()
    if a.print_expected:
        print(json.dumps({"expected": EXPECTED}))
        return
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)
    except Exception:
        pass
    servers, info = {}, []
    tls_ctx = None
    if a.tls:  # a self-signed certificate, like most station web servers
        import ssl
        import tempfile
        d = tempfile.mkdtemp(prefix="hs-tls-")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{d}/k.pem", "-out", f"{d}/c.pem",
                        "-days", "30", "-subj", "/CN=lab-station"], check=True, capture_output=True)
        tls_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        tls_ctx.load_cert_chain(f"{d}/c.pem", f"{d}/k.pem")
        der = ssl.PEM_cert_to_DER_cert(open(f"{d}/c.pem").read())
        fingerprint = hashlib.sha256(der).hexdigest()
    kinds = [("v3", "scram"), ("v4", "scram"), ("v3", "basic"), ("v4", "none")]
    for i in range(a.servers):
        fmt, auth = kinds[i % len(kinds)]
        name = f"hs-{i + 1:02d}"
        ip = f"{a.base}{a.first + i}"
        s = HServer(name, ip, fmt, auth)
        await asyncio.start_server(s.handle, ip, 80)
        if a.tls:
            await asyncio.start_server(s.handle, ip, 443, ssl=tls_ctx)
        servers[name] = s
        info.append({"name": name, "url": f"http://{ip}/api/lab", "user": USER, "password": PASSWORD,
                     "auth": "auto", "format": fmt, "login": auth,
                     **({"tls_url": f"https://{ip}/api/lab", "tls_fingerprint": fingerprint} if a.tls else {})})

    async def control(reader, writer):
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                r = json.loads(line)
                out = {"ok": True}
                if r["cmd"] == "fault":
                    s = servers[r["dev"]]
                    f, on, v = r["f"], r.get("on", True), r.get("v", True)
                    if f == "offline":
                        fw(["-I" if on else "-D", "INPUT", "-d", s.ip, "-p", "tcp", "--dport", "80", "-j", "DROP"])
                        fw(["-I" if on else "-D", "OUTPUT", "-s", s.ip, "-p", "tcp", "--sport", "80", "-j", "DROP"])
                    elif f == "expire":
                        s.tokens.clear()
                    elif f == "status":
                        (s.status_fault.add if on else s.status_fault.discard)(v)
                    elif f == "remove":
                        (s.removed.add if on else s.removed.discard)(v)
                    elif on:
                        s.faults[f] = v
                    else:
                        s.faults.pop(f, None)
                elif r["cmd"] == "stats":
                    out["servers"] = {n: s.stats for n, s in servers.items()}
                else:
                    raise ValueError(r["cmd"])
            except Exception as e:
                out = {"ok": False, "error": repr(e)}
            writer.write((json.dumps(out) + "\n").encode())
            await writer.drain()

    if a.control:
        try:
            os.unlink(a.control)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(control, path=a.control)
    print(json.dumps({"ready": True, "devices": info}), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
