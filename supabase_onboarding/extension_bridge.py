"""
Python WebSocket bridge client - the harness that steers the Chrome extension.

Architecture:
    Python backend (this module)  <-→  Chrome extension (background.js)
                      WebSocket on ws://localhost:8787

The Python side:
  1. Starts a WebSocket server on localhost:8787
  2. Waits for the extension to connect (extension auto-connects on load)
  3. Sends commands (fetch, tabs.open, form.fill, xhr.intercept, etc.)
  4. Receives results + xhr.event notifications
  5. Exposes high-level methods that orchestrate the signup flow

The extension is a "dumb interaction proxy" - it contains zero business
logic. All intelligence lives here.

High-level flow for `signup_with_extension(email, password)`:
  1. extension.tabs.open(https://supabase.com/dashboard/sign-up)
  2. extension.form.fill(email field, email)
  3. extension.form.fill(password field, password)
  4. Wait for user to solve hCaptcha (extension monitors DOM)
     - OR: extension reads hCaptcha token via getCaptchaToken
  5. extension.form.click(Continue button)
  6. extension.xhr.intercept(/platform/signup) -> captures the request
     (we don't need the response - we already know the request shape)
  7. Python polls email worker for the verify link
  8. Python follows the verify link natively (no extension needed)
  9. Python runs all subsequent operations natively (no extension needed)

The extension is only needed for steps 1-6 (the hCaptcha-protected flow).
After that, the Python backend has full access via the JWT access_token
captured from the verify redirect.

Note: This module is the client-side library. The actual WebSocket SERVER
is in scripts/run_bridge_aiohttp.py. This client connects to that server
and sends commands. The server relays them to the extension.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

try:
    import aiohttp
except ImportError as e:
    raise ImportError(
        "ExtensionBridge requires aiohttp. Install with: pip install aiohttp"
    ) from e

log = logging.getLogger("supabase_onboarding.extension_bridge")


# ---------------------------------------------------------------------- #
# Command/response protocol
# ---------------------------------------------------------------------- #

@dataclass
class CommandResult:
    """Result of a command sent to the extension."""
    ok: bool
    error: str | None = None
    data: dict = field(default_factory=dict)

    def get(self, key: str, default=None):
        return self.data.get(key, default) if self.data else default


class ExtensionBridge:
    """
    High-level client for the Chrome extension via the bridge daemon.

    This connects to the bridge daemon (scripts/run_bridge_aiohttp.py)
    over HTTP and sends commands. The daemon relays them to the extension
    over WebSocket.

    Usage:
        bridge = ExtensionBridge(host='localhost', port=8787)
        await bridge.connect()              # connect to the daemon
        await bridge.wait_for_extension()   # wait for extension to connect
        result = await bridge.fetch('https://api.supabase.com/...')
        result = await bridge.tabs_open('https://supabase.com/dashboard/sign-up')
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8787,
        *,
        scheme: str = "http",
        auth_token: str = "",
        timeout: float = 30.0,
    ):
        self.host = host
        self.port = port
        self.scheme = scheme
        self.auth_token = auth_token
        self.timeout = timeout
        self._base_url = f"{scheme}://{host}:{port}"
        self._session: aiohttp.ClientSession | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def connect(self) -> None:
        """Open the HTTP session to the bridge daemon."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout + 10),
            )
        # Check the daemon is alive
        async with self._session.get(f"{self._base_url}/health") as r:
            if r.status != 200:
                raise ConnectionError(
                    f"Bridge daemon at {self._base_url} returned {r.status} on /health"
                )
            data = await r.json()
            log.info("Bridge daemon connected: %s", data)

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def __aenter__(self) -> "ExtensionBridge":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #
    async def is_extension_connected(self) -> bool:
        """Check if the Chrome extension is connected to the daemon."""
        if not self._session:
            return False
        async with self._session.get(f"{self._base_url}/health") as r:
            if r.status != 200:
                return False
            data = await r.json()
            return bool(data.get("extension_connected"))

    async def wait_for_extension(self, timeout: float = 300.0) -> None:
        """Wait for the extension to connect. Blocks until connected or timeout.

        Default timeout is 5 minutes - gives the user time to load the
        extension and click Connect.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            if await self.is_extension_connected():
                log.info("Extension is connected")
                return
            await asyncio.sleep(1.0)
        raise TimeoutError(
            f"Extension did not connect within {timeout:.0f}s. "
            f"Load the extension in Chrome and click Connect."
        )

    # ------------------------------------------------------------------ #
    # Command sending (via the daemon's /api/command endpoint)
    # ------------------------------------------------------------------ #
    async def _send_command(self, cmd: dict, timeout: float | None = None) -> CommandResult:
        """Send a command to the extension via the daemon. Returns the result."""
        if not self._session:
            await self.connect()
        assert self._session is not None
        payload = dict(cmd)
        payload["timeout"] = timeout or self.timeout
        async with self._session.post(
            f"{self._base_url}/api/command",
            json=payload,
        ) as r:
            if r.status == 503:
                raise ConnectionError(
                    "Extension is not connected to the bridge daemon. "
                    "Load the extension and click Connect."
                )
            if r.status != 200:
                text = await r.text()
                raise RuntimeError(f"Daemon returned {r.status}: {text[:200]}")
            result = await r.json()
        ok = result.get("ok", False)
        if not ok:
            return CommandResult(ok=False, error=result.get("error", "Unknown error"), data=result)
        return CommandResult(ok=True, data=result)

    # ------------------------------------------------------------------ #
    # High-level command methods (mirror the notion bridge API)
    # ------------------------------------------------------------------ #
    async def fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: dict | None = None,
        body: str | None = None,
        credentials: str = "include",
        timeout_ms: int = 30000,
    ) -> CommandResult:
        """Execute fetch() from the extension's browser context.

        The request uses the browser's real:
          - IP address (residential, not datacenter)
          - TLS fingerprint (real Chrome)
          - Cookies (including Cloudflare __cf_bm, hCaptcha, etc.)
          - User-Agent + sec-ch-ua headers
        """
        cmd = {
            "type": "fetch",
            "url": url,
            "method": method,
            "headers": headers or {},
            "credentials": credentials,
            "timeoutMs": timeout_ms,
        }
        if body:
            cmd["body"] = body
        return await self._send_command(cmd, timeout=timeout_ms / 1000 + 5)

    async def tabs_open(self, url: str, *, active: bool = True) -> CommandResult:
        """Open a URL in a new tab. Returns the tabId."""
        return await self._send_command(
            {"type": "tabs.open", "url": url, "active": active}, timeout=60,
        )

    async def tabs_close(self, tab_id: int) -> CommandResult:
        """Close a tab by tabId."""
        return await self._send_command({"type": "tabs.close", "tabId": tab_id})

    async def tabs_list(self) -> CommandResult:
        """List all open tabs."""
        return await self._send_command({"type": "tabs.list"})

    async def tabs_focus(self, tab_id: int) -> CommandResult:
        """Focus a tab by tabId."""
        return await self._send_command({"type": "tabs.focus", "tabId": tab_id})

    async def form_fill(self, tab_id: int, selector: str, value: str) -> CommandResult:
        """Fill a form field by CSS selector. Uses the native input setter
        so it works with React-controlled inputs."""
        return await self._send_command({
            "type": "form.fill",
            "tabId": tab_id,
            "selector": selector,
            "value": value,
        })

    async def form_click(self, tab_id: int, selector: str) -> CommandResult:
        """Click an element by CSS selector."""
        return await self._send_command({
            "type": "form.click",
            "tabId": tab_id,
            "selector": selector,
        })

    async def form_wait(self, tab_id: int, selector: str, *, timeout_ms: int = 30000) -> CommandResult:
        """Wait for an element to appear in the DOM."""
        return await self._send_command({
            "type": "form.wait",
            "tabId": tab_id,
            "selector": selector,
            "timeoutMs": timeout_ms,
        }, timeout=timeout_ms / 1000 + 5)

    async def form_eval(self, tab_id: int, function: str, args: list | None = None) -> CommandResult:
        """Execute a JS function in the tab's context.

        The function receives a single `args` array and returns a value.
        Example:
            await bridge.form_eval(tab_id, "return document.querySelector('input')?.value")
        """
        return await self._send_command({
            "type": "form.eval",
            "tabId": tab_id,
            "function": function,
            "args": args or [],
        })

    async def xhr_intercept(
        self,
        tab_id: int,
        url_pattern: str,
        *,
        method: str | None = None,
        timeout_ms: int = 30000,
    ) -> CommandResult:
        """Intercept the next XHR matching `url_pattern` (regex). Returns
        the request body + response body + headers.

        Uses the chrome.debugger API. The result contains an `xhr` field
        with: {method, url, requestHeaders, requestBody, responseStatus,
        responseHeaders, responseBody}.
        """
        return await self._send_command({
            "type": "xhr.intercept",
            "tabId": tab_id,
            "urlPattern": url_pattern,
            "method": method,
            "timeoutMs": timeout_ms,
        }, timeout=timeout_ms / 1000 + 10)

    async def cookies_get(self, url: str, name: str) -> CommandResult:
        """Get a single cookie by name + URL."""
        return await self._send_command({"type": "cookies.get", "url": url, "name": name})

    async def cookies_get_all(self, url: str) -> CommandResult:
        """Get all cookies for a URL."""
        return await self._send_command({"type": "cookies.getAll", "url": url})

    async def cookies_set(self, url: str, cookies: list[dict]) -> CommandResult:
        """Set cookies for a URL."""
        return await self._send_command({"type": "cookies.set", "url": url, "cookies": cookies})

    async def screenshot(self, tab_id: int) -> CommandResult:
        """Take a screenshot of the visible tab. Returns a data URL."""
        return await self._send_command({"type": "screenshot", "tabId": tab_id})

    async def get_captcha_token(self, tab_id: int) -> CommandResult:
        """Read the hCaptcha response token from a tab.

        Tries `hcaptcha.getResponse()` first, then falls back to reading
        the value from the hidden `g-recaptcha-response` / `h-captcha-response`
        textarea that hCaptcha's JS SDK populates after solving.
        """
        return await self._send_command({"type": "getCaptchaToken", "tabId": tab_id}, timeout=15)

    # ------------------------------------------------------------------ #
    # Convenience: high-level Supabase signup via the extension
    # ------------------------------------------------------------------ #
    async def signup_with_extension(
        self,
        email: str,
        password: str,
        *,
        captcha_wait_timeout: float = 300.0,
    ) -> dict:
        """Drive the Supabase signup form via the extension.

        Flow:
          1. Open https://supabase.com/dashboard/sign-up
          2. Fill email + password
          3. Wait for the user to solve the hCaptcha (or for the headless
             hCaptcha to auto-solve if it does)
          4. Click Continue
          5. Intercept the POST /platform/signup XHR - captures whether
             it succeeded (201) or failed (401/403)

        Returns a dict with:
          - ok: bool
          - tab_id: int (the signup tab - keep open for any post-signup
            browser interactions)
          - signup_status: int (201 = success)
          - signup_response: dict (the response body, usually empty for 201)

        After this returns successfully, the caller should poll the email
        worker for the verify link and follow it natively (no extension
        needed).
        """
        log.info("Starting extension-based signup for %s", email)
        # Step 1: open the signup page
        tab_result = await self.tabs_open("https://supabase.com/dashboard/sign-up")
        if not tab_result.ok:
            return {"ok": False, "error": f"Failed to open signup page: {tab_result.error}"}
        tab_id = tab_result.get("tabId")
        log.info("Opened signup page in tab %d", tab_id)

        # Step 2: wait for the form to load + fill it
        # The signup form uses React-controlled inputs - use form_fill which
        # dispatches native input events.
        await self.form_wait(tab_id, 'input[type="email"]', timeout_ms=15000)
        await self.form_fill(tab_id, 'input[type="email"]', email)
        await self.form_fill(tab_id, 'input[type="password"]', password)
        log.info("Filled email + password")

        # Step 3: wait for hCaptcha to be solved
        # The user needs to solve it manually in the browser tab.
        # We poll get_captcha_token until it returns a non-empty token.
        log.info(
            "Waiting for hCaptcha to be solved (timeout=%ds). "
            "Solve the captcha in the browser tab.",
            int(captcha_wait_timeout),
        )
        deadline = time.time() + captcha_wait_timeout
        captcha_token = None
        while time.time() < deadline:
            r = await self.get_captcha_token(tab_id)
            if r.ok and r.get("token"):
                captcha_token = r.get("token")
                break
            await asyncio.sleep(2.0)
        if not captcha_token:
            return {
                "ok": False,
                "error": "hCaptcha was not solved within the timeout",
                "tab_id": tab_id,
            }
        log.info("hCaptcha solved: token=%s...", captcha_token[:30])

        # Step 4: intercept the POST /platform/signup XHR
        # Set up the interceptor BEFORE clicking the button
        intercept_task = asyncio.create_task(
            self.xhr_intercept(
                tab_id,
                r"api\.supabase\.com/platform/signup",
                method="POST",
                timeout_ms=30000,
            )
        )
        # Give the interceptor a moment to attach
        await asyncio.sleep(0.5)

        # Click the Continue button
        click_r = await self.form_click(tab_id, 'button[type="submit"]')
        if not click_r.ok:
            log.warning("form.click failed: %s - trying alternative selectors", click_r.error)
            # Try alternative selectors - Supabase's button might not have type=submit
            for sel in ['button[data-testid="signup-submit"]', 'button:has-text("Sign up")', 'button']:
                click_r = await self.form_click(tab_id, sel)
                if click_r.ok:
                    break

        # Wait for the XHR to be captured
        try:
            xhr_result = await intercept_task
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": "POST /platform/signup XHR was not captured within 30s",
                "tab_id": tab_id,
            }

        if not xhr_result.ok:
            return {
                "ok": False,
                "error": f"xhr_intercept failed: {xhr_result.error}",
                "tab_id": tab_id,
            }
        xhr = xhr_result.get("xhr") or {}
        status = xhr.get("responseStatus", 0)
        resp_body = xhr.get("responseBody", "")
        log.info("Captured POST /platform/signup: status=%d body=%s", status, resp_body[:200])

        if status != 201:
            return {
                "ok": False,
                "error": f"Signup failed with HTTP {status}: {resp_body[:300]}",
                "tab_id": tab_id,
                "signup_status": status,
                "signup_response": resp_body,
            }
        return {
            "ok": True,
            "tab_id": tab_id,
            "signup_status": status,
            "signup_response": resp_body,
        }


__all__ = ["ExtensionBridge", "CommandResult"]
