"""remote-mouse server: turns a phone browser into a trackpad for this PC.

Run it on the machine you want to control:

    python server/main.py

It prints the LAN URL and a QR code; scan that with the phone, and the page it
serves streams finger gestures back over a WebSocket, which this process injects
as real cursor and keyboard events.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path
from secrets import compare_digest
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import input_backend
from config import REPO_ROOT, load_config

CONFIG: dict[str, Any] = load_config()
BACKEND = input_backend.make_backend(CONFIG)
WEB_DIR = REPO_ROOT / "web"

app = FastAPI(title="remote-mouse")


def lan_addresses() -> list[str]:
    """Best-effort list of this machine's LAN IPs, most-likely-useful first.

    The UDP-connect trick asks the OS which interface it would use to reach the
    outside world without sending a packet; that is nearly always the interface
    the phone is also on. Hostname resolution is a fallback for multi-homed
    machines.
    """
    addresses: list[str] = []
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        addresses.append(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in addresses:
                addresses.append(ip)
    except OSError:
        pass
    return addresses or ["127.0.0.1"]


def print_banner() -> None:
    port = CONFIG["port"]
    pin = CONFIG["pin"]
    urls = [f"http://{ip}:{port}/?k={pin}" for ip in lan_addresses()]
    print()
    print("  remote-mouse is running. Open this on your phone:")
    print()
    for url in urls:
        print(f"    {url}")
    print()
    print(f"  pairing PIN: {pin}   (set \"pin\" in config.json to keep it fixed)")
    print(f"  input backend: {type(BACKEND).__name__}")
    print()
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(urls[0])
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        print("  (pip install qrcode for a scannable QR code here)")
    print()


def authorised(supplied: str | None) -> bool:
    return bool(supplied) and compare_digest(str(supplied), CONFIG["pin"])


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "backend": type(BACKEND).__name__}


@app.get("/debug/actions")
async def debug_actions(clear: bool = False):
    """What the backend would have done. Only exists on the dry-run backend, so
    it can't be used to snoop on a real session."""
    if not isinstance(BACKEND, input_backend.DryRunBackend):
        return JSONResponse({"error": "not running the dry-run backend"}, status_code=404)
    actions = list(BACKEND.actions)
    if clear:
        BACKEND.actions.clear()
    return {"actions": actions}


def handle_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """Apply one protocol message. Returns a reply to send back, if any."""
    kind = message.get("t")
    if kind == "m":
        BACKEND.move(float(message.get("dx", 0)), float(message.get("dy", 0)))
    elif kind == "d":
        BACKEND.button(str(message.get("b", "l")), message.get("s") == "down")
    elif kind == "s":
        BACKEND.scroll(float(message.get("dx", 0)), float(message.get("dy", 0)))
    elif kind == "z":
        BACKEND.zoom(float(message.get("d", 0)))
    elif kind == "g":
        name = str(message.get("g", ""))
        if not BACKEND.gesture(name):
            return {"t": "warn", "msg": f"no mapping for gesture {name}"}
    elif kind == "ping":
        return {"t": "pong"}
    return None


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    if not authorised(ws.query_params.get("k")):
        # Accept first, then close with a policy-violation code: rejecting during
        # the handshake instead only reaches the browser as a generic failed
        # connection, so the page could not tell "wrong PIN" from "PC asleep"
        # and would retry a bad PIN forever.
        await ws.close(code=1008)
        return
    await ws.send_text(json.dumps({"t": "hello", "backend": type(BACKEND).__name__}))
    try:
        while True:
            raw = await ws.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            reply = handle_message(message)
            if reply is not None:
                await ws.send_text(json.dumps(reply))
    except WebSocketDisconnect:
        pass
    except (RuntimeError, ValueError, TypeError) as exc:
        print(f"[ws] dropping client: {exc}")
    finally:
        # A phone that walks out of Wi-Fi range mid-drag must not leave a button
        # held down on the desktop.
        BACKEND.release_all()


# Mounted last: it is a root catch-all, so every API route above must already be
# registered for those paths to win.
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


def main() -> None:
    import uvicorn

    print_banner()
    uvicorn.run(
        app,
        host=CONFIG["host"],
        port=int(CONFIG["port"]),
        log_level=os.environ.get("REMOTE_MOUSE_LOG", "warning"),
        ws_ping_interval=20,
    )


if __name__ == "__main__":
    main()
