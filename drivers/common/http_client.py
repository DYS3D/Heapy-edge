"""
HEAPY Edge - small HTTP(S) client for the web-based drivers (Haystack, oBIX).

One keep-alive connection per server, one request at a time (servers such as
Niagara stations are easily overloaded). Runs the blocking stdlib client in a
worker thread so the driver stays responsive.

TLS: certificates are checked by default. Sites with self-signed certificates
can pin the server's certificate instead (tls_fingerprint: SHA-256 of the
certificate, hex); turning checks off (verify_tls: false) is allowed but logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import http.client
import socket
import ssl
import threading
import time
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit


class HttpDown(Exception):
    """Cannot connect at all (refused, unreachable, DNS, TLS setup)."""


class HttpTimeout(Exception):
    """Connected, but no complete answer in time."""


class TlsMismatch(Exception):
    """The server's certificate is not the one we trust."""


class Response:
    def __init__(self, status: int, headers: Dict[str, str], body: bytes):
        self.status, self.headers, self.body = status, headers, body

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")


class HttpClient:
    def __init__(self, base_url: str, timeout: float = 10.0, verify_tls: bool = True,
                 tls_fingerprint: str = "", max_body: int = 64 * 1024 * 1024):
        u = urlsplit(base_url.rstrip("/"))
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError(f"not an http(s) address: {base_url}")
        self.scheme, self.host = u.scheme, u.hostname
        self.port = u.port or (443 if u.scheme == "https" else 80)
        self.path = u.path or ""
        self.timeout = timeout
        self.verify = verify_tls
        self.fp = tls_fingerprint.replace(":", "").lower().strip()
        self.max_body = max_body
        self.conn: Optional[http.client.HTTPConnection] = None
        self.lock = threading.Lock()
        self.down_until = 0.0
        self.down_msg = ""

    def _ctx(self) -> ssl.SSLContext:
        if self.fp or not self.verify:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE  # checked by fingerprint below, or not at all (verify_tls false)
            return ctx
        return ssl.create_default_context()

    def _open(self) -> http.client.HTTPConnection:
        if self.conn is not None:
            return self.conn
        if time.monotonic() < self.down_until:
            raise HttpDown(self.down_msg)
        try:
            if self.scheme == "https":
                c = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=self._ctx())
            else:
                c = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
            c.connect()
            if self.scheme == "https" and self.fp:
                der = c.sock.getpeercert(binary_form=True)
                got = hashlib.sha256(der).hexdigest()
                if got != self.fp:
                    c.close()
                    raise TlsMismatch(f"certificate fingerprint {got} is not the trusted one")
            try:
                c.sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            except OSError:
                pass
        except TlsMismatch:
            raise
        except ssl.SSLCertVerificationError as e:
            # tell the technician exactly which certificate this is, so it can be pinned
            try:
                pem = ssl.get_server_certificate((self.host, self.port), timeout=self.timeout)
                fp = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
                raise TlsMismatch(f"certificate not trusted ({e.verify_message}); if this is the right server, "
                                  f"set tls_fingerprint to {fp}")
            except TlsMismatch:
                raise
            except Exception:
                raise TlsMismatch(f"certificate not trusted ({e.verify_message})")
        except (OSError, ssl.SSLError, http.client.HTTPException) as e:
            self.down_until = time.monotonic() + min(5.0, self.timeout)
            self.down_msg = f"cannot connect to {self.host}:{self.port} ({type(e).__name__}: {e})"
            raise HttpDown(self.down_msg)
        self.conn = c
        return c

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = None

    def _request(self, method: str, path: str, body: Optional[bytes], headers: Dict[str, str]) -> Response:
        with self.lock:
            for attempt in (0, 1):
                fresh = self.conn is None
                c = self._open()
                try:
                    c.request(method, self.path + path, body=body, headers=headers)
                    r = c.getresponse()
                    data = r.read(self.max_body + 1)
                    if len(data) > self.max_body:
                        self.close()
                        raise HttpTimeout("reply too large")
                    hdrs = {k.lower(): v for k, v in r.getheaders()}
                    if hdrs.get("connection", "").lower() == "close" or r.will_close:
                        self.close()
                    return Response(r.status, hdrs, data)
                except (socket.timeout, TimeoutError):
                    self.close()
                    raise HttpTimeout("no answer")
                except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError,
                        http.client.BadStatusLine, http.client.IncompleteRead, ConnectionAbortedError) as e:
                    self.close()
                    if attempt == 0 and not fresh:
                        continue  # the server had closed our idle connection: once more on a new one
                    raise HttpTimeout(f"connection dropped ({type(e).__name__})")
                except (OSError, ssl.SSLError, http.client.HTTPException) as e:
                    self.close()
                    raise HttpTimeout(f"{type(e).__name__}: {e}")
            raise HttpTimeout("connection dropped")

    async def request(self, method: str, path: str, body: Optional[bytes] = None,
                      headers: Optional[Dict[str, str]] = None) -> Response:
        h = {"Host": self.host, "User-Agent": "HEAPY-Edge", "Connection": "keep-alive", **(headers or {})}
        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(None, self._request, method, path, body, h)
        try:
            # the socket timeout covers each wait; this caps the whole exchange
            return await asyncio.wait_for(asyncio.shield(fut), self.timeout * 3 + 5)
        except asyncio.TimeoutError:
            self.close()
            raise HttpTimeout("no complete answer")
