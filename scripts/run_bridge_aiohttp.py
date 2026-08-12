#!/usr/bin/env python3
"""
Run the Supabase Onboarding Bridge as a long-running mini-service using aiohttp.

This is the WebSocket server that the Chrome extension connects to. It also
exposes HTTP endpoints for the Python client (supabase_onboarding.extension_bridge)
to send commands to the extension.

Architecture:
    Python automation script
        ↓ HTTP (POST /api/command)
    Bridge daemon (this script)
        ↓ WebSocket (/ws)
    Chrome extension (background.js)

The daemon is double-forked via scripts/run_bridge.py so it survives
bash toolcall boundaries in the sandbox.

Usage:
    python scripts/run_bridge_aiohttp.py [--port 8787] [--host 127.0.0.1]

HTTP endpoints:
    GET /          - HTML status page (with live extension status)
    GET /health    - JSON health check
    GET /api/token - auth token for the extension
    POST /api/command - send any command to the extension
    POST /api/open - open a URL in a new tab
    POST /api/eval - execute JS in a tab
    POST /api/screenshot - take a screenshot
    POST /api/cookies - get all cookies for a URL
    POST /api/fetch - execute fetch() from the extension
    POST /api/captcha-token - read hCaptcha token from a tab

WebSocket:
    ws://<host>:<port>/ws  (the extension connects here)

For remote access via the preview URL:
    wss://preview-<bot-id>.space-z.ai/ws?XTransformPort=8787
    https://preview-<bot-id>.space-z.ai/health?XTransformPort=8787
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web, WSMsgType

log = logging.getLogger("supabase_onboarding.bridge")

# Shared state - accessible from both HTTP and WebSocket handlers
STATE = {
    "started_at": time.time(),
    "extension_connected": False,
    "extension_info": {},
    "commands_received": 0,
    "commands_completed": 0,
    "commands_failed": 0,
    "last_command_at": None,
    "recent_logs": [],
}

# Pending command futures: {command_id: asyncio.Future}
PENDING: dict[str, asyncio.Future] = {}
# The active WebSocket connection (extension service worker)
WS_CONN: web.WebSocketResponse | None = None

MAX_LOG = 200


def add_log(level: str, message: str, data: dict | None = None):
    """Add a log entry to the recent logs ring buffer."""
    entry = {
        "ts": time.time(),
        "level": level,
        "message": message,
        "data": data or {},
    }
    STATE["recent_logs"].append(entry)
    if len(STATE["recent_logs"]) > MAX_LOG:
        STATE["recent_logs"].pop(0)
    log.info("[%s] %s %s", level, message, data or "")


# ---------------------------------------------------------------------- #
# HTTP handlers
# ---------------------------------------------------------------------- #

async def handle_health(request: web.Request) -> web.Response:
    """GET /health - JSON health check."""
    return web.json_response({
        "ok": True,
        "service": "supabase-onboarding-bridge",
        "uptime_seconds": time.time() - STATE["started_at"],
        "extension_connected": STATE["extension_connected"],
        "extension_info": STATE["extension_info"],
        "commands_received": STATE["commands_received"],
        "commands_completed": STATE["commands_completed"],
        "commands_failed": STATE["commands_failed"],
    })


async def handle_root(request: web.Request) -> web.StreamResponse:
    """GET / - dispatch based on Upgrade header."""
    upgrade = request.headers.get("Upgrade", "").lower()
    connection = request.headers.get("Connection", "").lower()
    if "websocket" in upgrade or "upgrade" in connection:
        return await handle_websocket(request)
    return await handle_status_page(request)


async def handle_token(request: web.Request) -> web.Response:
    """GET /api/token - auth token for the extension."""
    return web.json_response({"token": ""})  # no auth in dev mode


async def handle_status_page(request: web.Request) -> web.Response:
    """GET / - HTML status page."""
    uptime = time.time() - STATE["started_at"]
    ext_connected = STATE["extension_connected"]
    ext_info = STATE["extension_info"]
    port = request.app["port"]
    host = request.app["host"]

    ws_url_local = f"ws://localhost:{port}/ws"
    ws_url_remote = f"wss://preview-<bot-id>.space-z.ai/ws?XTransformPort={port}"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Supabase Onboarding Bridge</title>
<meta http-equiv="refresh" content="5">
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; background: #fafafa; color: #1a1a1a; }}
h1 {{ color: #3ECF8E; margin-bottom: 8px; }}
.status {{ padding: 12px 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; }}
.status.connected {{ background: #e6f4ea; color: #137333; }}
.status.disconnected {{ background: #fce8e6; color: #c5221f; }}
code {{ background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; word-break: break-all; }}
pre {{ background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }}
ul {{ line-height: 1.8; }}
.section {{ margin: 20px 0; padding: 16px; background: white; border-radius: 8px; border: 1px solid #eee; }}
.stats {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 12px 0; }}
.stat {{ background: #f8f9fa; padding: 8px 12px; border-radius: 6px; text-align: center; }}
.stat-label {{ font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }}
.stat-value {{ font-size: 20px; font-weight: 600; color: #1a1a1a; }}
.stat-value.failed {{ color: #db4437; }}
</style>
</head>
<body>
<h1>Supabase Onboarding Bridge</h1>
<p style="color: #666; font-size: 14px;">Python backend service for the Chrome extension</p>

<div class="status {'connected' if ext_connected else 'disconnected'}">
  Extension: <strong>{'✓ CONNECTED' if ext_connected else '✗ DISCONNECTED'}</strong>
  {f"— Agent: {ext_info.get('agentId', '?')}" if ext_connected else ""}
</div>

<div class="stats">
  <div class="stat">
    <div class="stat-label">Uptime</div>
    <div class="stat-value">{uptime:.0f}s</div>
  </div>
  <div class="stat">
    <div class="stat-label">Commands</div>
    <div class="stat-value">{STATE['commands_completed']}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Failed</div>
    <div class="stat-value failed">{STATE['commands_failed']}</div>
  </div>
</div>

<div class="section">
  <h3>🔌 Connect the Chrome Extension</h3>
  <ol>
    <li>Load the extension in Chrome: <code>chrome://extensions/</code> → Developer mode → Load unpacked</li>
    <li>Click the extension icon in your toolbar</li>
    <li>Set Server URL to one of:
      <ul>
        <li><strong>Local:</strong> <code>{ws_url_local}</code></li>
        <li><strong>Remote:</strong> <code>{ws_url_remote}</code></li>
      </ul>
    </li>
    <li>Click <strong>Connect</strong></li>
  </ol>
</div>

<div class="section">
  <h3>📋 CLI Commands</h3>
  <pre>python automate.py signup-ext --email you@privatimail.com --password 'StrongPass123!'
python automate.py run-full-ext --email you@privatimail.com --password 'StrongPass123!'</pre>
</div>

<div class="section">
  <h3>🔍 API Endpoints</h3>
  <ul>
    <li><code>GET /health</code> — JSON health check</li>
    <li><code>GET /api/token</code> — auth token</li>
    <li><code>GET /</code> — this page (auto-refreshes every 5s)</li>
    <li><code>WS /ws</code> — WebSocket for extension</li>
    <li><code>POST /api/command</code> — send command to extension</li>
  </ul>
</div>

<div class="section">
  <h3>📊 Recent Logs</h3>
  <pre>{_format_logs(STATE['recent_logs'][-15:])}</pre>
</div>

</body>
</html>"""
    return web.Response(text=html, content_type="text/html")


def _format_logs(logs: list) -> str:
    if not logs:
        return "(no logs yet)"
    lines = []
    for e in logs[-15:]:
        t = time.strftime("%H:%M:%S", time.localtime(e["ts"]))
        lines.append(f"[{t}] {e['level'].upper():5s} {e['message']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- #
# WebSocket handler — extension connects here
# ---------------------------------------------------------------------- #

async def handle_websocket(request: web.Request) -> web.WebSocketResponse:
    """WS /ws - WebSocket endpoint for the Chrome extension."""
    global WS_CONN

    ws = web.WebSocketResponse(max_msg_size=50 * 1024 * 1024)
    await ws.prepare(request)

    add_log("info", "WebSocket connection from extension")

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    add_log("warn", f"Invalid JSON from extension: {msg.data[:200]}")
                    continue

                msg_type = data.get("type", "")

                if msg_type == "auth":
                    add_log("debug", f"Extension auth: {data.get('token', '')[:20]}")

                elif msg_type == "connect":
                    WS_CONN = ws
                    STATE["extension_connected"] = True
                    STATE["extension_info"] = {
                        "agentId": data.get("agentId"),
                        "userAgent": data.get("userAgent"),
                        "hostname": data.get("hostname"),
                    }
                    add_log("info", f"Extension identified: {STATE['extension_info']}")

                elif msg_type == "result":
                    cmd_id = data.get("id")
                    if cmd_id and cmd_id in PENDING:
                        fut = PENDING.pop(cmd_id)
                        if not fut.done():
                            fut.set_result(data)
                        STATE["commands_completed"] += 1
                    else:
                        add_log("warn", f"Result for unknown command: {cmd_id}")

                elif msg_type == "log":
                    level = data.get("level", "info")
                    message = data.get("message", "")
                    log_data = data.get("data", {})
                    add_log(level, f"[ext] {message}", log_data)

                elif msg_type == "pong":
                    pass  # keepalive

                else:
                    add_log("debug", f"Unknown message type: {msg_type}")

            elif msg.type == WSMsgType.ERROR:
                add_log("error", f"WebSocket error: {ws.exception()}")

    except Exception as e:
        add_log("error", f"WebSocket handler error: {e}")
    finally:
        WS_CONN = None
        STATE["extension_connected"] = False
        # Fail any pending commands
        for fut in PENDING.values():
            if not fut.done():
                fut.set_exception(ConnectionError("Extension disconnected"))
        PENDING.clear()
        add_log("info", "Extension disconnected")

    return ws


# ---------------------------------------------------------------------- #
# Command sending (used by HTTP /api/* endpoints)
# ---------------------------------------------------------------------- #

async def send_command(cmd: dict, timeout: float = 30.0) -> dict:
    """Send a command to the extension via WebSocket and wait for result."""
    if WS_CONN is None:
        raise ConnectionError("Extension is not connected")

    cmd_id = str(uuid.uuid4())
    cmd["id"] = cmd_id
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    PENDING[cmd_id] = fut

    STATE["commands_received"] += 1
    STATE["last_command_at"] = time.time()

    add_log("info", f"→ {cmd.get('type')} (id={cmd_id[:8]})")
    await WS_CONN.send_json(cmd)

    try:
        result = await asyncio.wait_for(fut, timeout=timeout)
        return result
    except asyncio.TimeoutError:
        PENDING.pop(cmd_id, None)
        STATE["commands_failed"] += 1
        return {"ok": False, "error": f"Command {cmd.get('type')} timed out after {timeout}s"}


# ---------------------------------------------------------------------- #
# Remote portal API — lets the Python client drive the extension via HTTP
# ---------------------------------------------------------------------- #

async def handle_api_command(request: web.Request) -> web.Response:
    """POST /api/command - send any command to the extension.

    Body: {"type": "fetch"|"tabs.open"|..., ...command fields, "timeout": 30.0}
    Returns: the extension's result as JSON.
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        cmd = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    timeout = cmd.pop("timeout", 60.0)
    try:
        result = await send_command(cmd, timeout=timeout)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_open(request: web.Request) -> web.Response:
    """POST /api/open - open a URL in a new tab."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    active = body.get("active", True)
    try:
        result = await send_command({"type": "tabs.open", "url": url, "active": active}, timeout=60)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_eval(request: web.Request) -> web.Response:
    """POST /api/eval - execute JS in a tab."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    function = body.get("function")
    if tab_id is None or not function:
        return web.json_response({"ok": False, "error": "Missing 'tabId' or 'function'"}, status=400)
    args = body.get("args", [])
    try:
        result = await send_command({
            "type": "form.eval", "tabId": tab_id,
            "function": function, "args": args,
        }, timeout=30)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_screenshot(request: web.Request) -> web.Response:
    """POST /api/screenshot - take a screenshot of a tab."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    if tab_id is None:
        return web.json_response({"ok": False, "error": "Missing 'tabId'"}, status=400)
    try:
        result = await send_command({"type": "screenshot", "tabId": tab_id}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_cookies(request: web.Request) -> web.Response:
    """POST /api/cookies - get all cookies for a URL."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    try:
        result = await send_command({"type": "cookies.getAll", "url": url}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_fetch(request: web.Request) -> web.Response:
    """POST /api/fetch - execute fetch() from the extension's browser context."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    cmd = {
        "type": "fetch",
        "url": url,
        "method": body.get("method", "GET"),
        "headers": body.get("headers", {}),
        "credentials": body.get("credentials", "include"),
        "timeoutMs": body.get("timeoutMs", 30000),
    }
    if "body" in body:
        cmd["body"] = body["body"]
    try:
        result = await send_command(cmd, timeout=body.get("timeoutMs", 30000) / 1000 + 5)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_captcha_token(request: web.Request) -> web.Response:
    """POST /api/captcha-token - read the hCaptcha response token from a tab."""
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    if tab_id is None:
        return web.json_response({"ok": False, "error": "Missing 'tabId'"}, status=400)
    try:
        result = await send_command({"type": "getCaptchaToken", "tabId": tab_id}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ---------------------------------------------------------------------- #
# Main server
# ---------------------------------------------------------------------- #

async def run(host: str, port: int) -> None:
    app = web.Application()
    app["host"] = host
    app["port"] = port

    # HTTP routes
    app.router.add_get("/", handle_root)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/token", handle_token)
    app.router.add_get("/ws", handle_websocket)

    # Remote portal API
    app.router.add_post("/api/command", handle_api_command)
    app.router.add_post("/api/open", handle_api_open)
    app.router.add_post("/api/eval", handle_api_eval)
    app.router.add_post("/api/screenshot", handle_api_screenshot)
    app.router.add_post("/api/cookies", handle_api_cookies)
    app.router.add_post("/api/fetch", handle_api_fetch)
    app.router.add_post("/api/captcha-token", handle_api_captcha_token)

    runner = web.AppRunner(app)
    await runner.setup()
    # Bind to 127.0.0.1 (IPv4 explicit) - Caddy's reverse_proxy connects via localhost
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()

    print(f"\n{'='*60}")
    print(f"  Supabase Onboarding Bridge is running (aiohttp)")
    print(f"  HTTP:  http://{host}:{port}/")
    print(f"  WS:    ws://{host}:{port}/ws")
    print(f"  Health: http://{host}:{port}/health")
    print(f"{'='*60}")
    print(f"\n  Extension WebSocket URL:")
    print(f"    Local:  ws://localhost:{port}/ws")
    print(f"    Remote: wss://preview-<bot-id>.space-z.ai/ws?XTransformPort={port}")
    print(f"\n  Status page: https://preview-<bot-id>.space-z.ai/?XTransformPort={port}")
    print(f"\n  Press Ctrl+C to stop.\n")

    # Write a sentinel file so the launcher knows we're up
    sentinel = Path(os.environ.get("BRIDGE_SENTINEL", "/tmp/supabase_bridge_ready"))
    try:
        sentinel.write_text(json.dumps({
            "host": "127.0.0.1", "port": port, "started_at": time.time(),
        }))
    except Exception:
        pass

    # Wait forever
    stop_event = asyncio.Event()

    def signal_handler():
        print("\nShutting down...")
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            signal.signal(sig, lambda s, f: signal_handler())

    try:
        await stop_event.wait()
    finally:
        await runner.cleanup()
        # Remove sentinel
        try:
            sentinel.unlink(missing_ok=True)
        except Exception:
            pass
        print("Bridge stopped.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Supabase Onboarding Bridge server (aiohttp)")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8787, help="Port (default: 8787)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )

    try:
        asyncio.run(run(args.host, args.port))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
