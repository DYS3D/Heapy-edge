"""
HEAPY Edge - shared plumbing for Python drivers (contract v1, see
contracts/driver-protocol.json): JSON lines on stdin/stdout, errors, rate limits.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import time
from typing import Any, Dict

_out_lock = asyncio.Lock()
NAME = "driver"


def _finite(o: Any) -> Any:
    if isinstance(o, float) and not math.isfinite(o):
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
    async with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[{NAME}] {msg}\n")
    sys.stderr.flush()


async def warn(msg: str) -> None:
    log(msg)
    await emit({"id": None, "event": "log", "data": {"level": "warn", "msg": msg}})


class DriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Limiter:
    """Keeps requests to one device at or under a rate."""

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


def finite_number(v: Any):
    """(number, None) or (None, error text)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None, f"not a number ({str(v)[:40]})"
    if not math.isfinite(f):
        return None, "invalid value"
    if isinstance(v, int) or f.is_integer() and abs(f) < 2 ** 53:
        return (int(v) if isinstance(v, int) else int(f)), None
    return f, None


class BaseDriver:
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
        except asyncio.TimeoutError:
            await emit({"id": rid, "ok": False, "error": {"code": "timeout", "message": "no answer"}})
        except Exception as e:  # keep the driver alive
            log(f"error in {req.get('op')}: {e!r}")
            await emit({"id": rid, "ok": False, "error": {"code": "internal", "message": repr(e)}})

    async def op_shutdown(self, req):
        await self.close()
        asyncio.get_running_loop().call_later(0.1, lambda: os._exit(0))
        return {"ok": True}

    async def close(self) -> None:
        pass


async def run(driver: BaseDriver) -> None:
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
        t = asyncio.create_task(driver.handle(req))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    os._exit(0)
