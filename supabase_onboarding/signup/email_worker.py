"""
Email worker client for querying a Cloudflare Email Worker instance.

Same instance as the Notion / Todoist onboarding automation — receives mail
for `*@privatimail.com` and exposes an HTTP API for querying the inbox.

The key difference from the Notion version: Supabase's verification email
contains a **verification link** (not a 6-digit code). We extract the
`https://auth.supabase.io/auth/v1/verify?token=...&type=signup&redirect_to=...`
URL from the email body.

Backed by the worker at https://github.com/ansgareutychisO/cloudflare-email-worker
(branch: feature/email-toughening). The worker exposes:

    GET /health                          — no auth, liveness check
    GET /emails?address=...&limit=...&before=...&include_body=true
                                         — paginated list (bodies opt-in)
    GET /emails/:id                      — single email detail with bodies
    GET /emails/:id/raw                  — raw MIME bytes (message/rfc822)
    GET /emails/:id/attachments          — list attachments
    GET /emails/:id/attachments/:attId   — attachment metadata
    DELETE /emails/:id                   — soft delete

All endpoints (except /health) require `Authorization: Bearer <QUERY_API_TOKEN>`.
"""

from __future__ import annotations

import re
import time
import logging
from datetime import datetime
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, parse_qs, unquote

import requests

log = logging.getLogger("supabase_onboarding.signup.email_worker")


# Supabase verification link pattern.
# The email contains a link like:
#   https://auth.supabase.io/auth/v1/verify?token=...&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in
#
# The HTML version may have the link split across lines or with HTML entities
# (e.g. `&amp;` instead of `&`). We normalize both.
VERIFY_LINK_PATTERN = re.compile(
    r"https?://auth\.supabase\.io/auth/v1/verify\?[^\s\"'<>]+",
    re.IGNORECASE,
)


@dataclass
class VerificationEmail:
    """A Supabase verification email found in the inbox."""

    id: int
    message_id: str
    from_address: str
    to_address: str
    subject: str
    received_at: str
    raw_size: int
    verify_url: str          # the full verify URL (with redirect_to, if present)
    token: str               # the token param from the URL
    verify_type: str = "signup"  # type param (signup, recovery, etc.)


class EmailWorkerError(Exception):
    """Raised when the email worker returns a non-2xx response."""

    def __init__(self, message: str, *, status_code: int | None = None,
                 payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class EmailWorkerClient:
    """
    Authenticated client for the Cloudflare Email Worker HTTP API.

    Example:
        >>> c = EmailWorkerClient(
        ...     base_url="https://mail-api.privatimail.com",
        ...     token="<QUERY_API_TOKEN>",
        ... )
        >>> v = c.wait_for_verify_link("user@privatimail.com", timeout=120)
        >>> v.verify_url  # the full URL
        >>> v.token       # the token param
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "supabase-onboarding-automation/0.1",
        })

    # ------------------------------------------------------------------ #
    # Low-level
    # ------------------------------------------------------------------ #
    def request(
        self, method: str, path: str, *,
        params: dict | None = None,
        expect_json: bool = True,
    ) -> Any:
        url = f"{self.base_url}{path}"
        log.debug("-> %s %s params=%s", method, url, params)
        r = self._session.request(method, url, params=params, timeout=self.timeout)
        log.debug("<- %s %s", r.status_code, r.reason)

        if r.status_code == 401:
            raise EmailWorkerError(
                "Unauthorized - check the EmailWorkerClient token",
                status_code=401, payload=r.text,
            )
        if r.status_code == 429:
            raise EmailWorkerError(
                "Rate limited by email worker",
                status_code=429, payload=r.text,
            )
        if not (200 <= r.status_code < 300):
            raise EmailWorkerError(
                f"Email worker returned HTTP {r.status_code}: {r.text[:300]}",
                status_code=r.status_code, payload=r.text,
            )

        if not expect_json:
            return r.content
        if not r.content:
            return None
        try:
            return r.json()
        except Exception as e:
            raise EmailWorkerError(
                f"Non-JSON response from {url}: {e}",
                status_code=r.status_code, payload=r.text[:500],
            ) from e

    # ------------------------------------------------------------------ #
    # High-level
    # ------------------------------------------------------------------ #
    def list_emails(
        self, address: str, *,
        limit: int = 20,
        before: str | None = None,
        include_body: bool = False,
    ) -> list[dict]:
        """GET /emails?address=...&limit=...&before=...&include_body=true"""
        params: dict = {"address": address, "limit": limit}
        if before:
            params["before"] = before
        if include_body:
            params["include_body"] = "true"
        resp = self.request("GET", "/emails", params=params)
        return (resp or {}).get("results", []) or []

    def get_email(self, email_id: int) -> dict:
        """GET /emails/:id - single email detail (always includes bodies)."""
        return self.request("GET", f"/emails/{email_id}") or {}

    def delete_email(self, email_id: int) -> dict:
        """DELETE /emails/:id - soft delete (also clears R2 if present)."""
        return self.request("DELETE", f"/emails/{email_id}") or {}

    # ------------------------------------------------------------------ #
    # Signup-flow helpers
    # ------------------------------------------------------------------ #
    def find_verification_email(
        self, address: str, *, since: float | None = None,
    ) -> VerificationEmail | None:
        """Look for a Supabase verification email addressed to `address`.

        Returns the most recent match, or None if not found.

        `since` (epoch seconds) optionally filters out emails received
        before that timestamp.
        """
        results = self.list_emails(address, limit=50, include_body=True)
        for em in results:
            if since is not None:
                received = em.get("received_at", "")
                try:
                    dt = datetime.fromisoformat(received.replace("Z", "+00:00"))
                    received_ts = dt.timestamp()
                except (ValueError, TypeError):
                    received_ts = 0
                if received_ts and received_ts < since:
                    continue
            # The text_body usually contains the link as plain text; html_body
            # may have it inside an <a href="..."> tag. Check both. Also
            # unescape HTML entities (`&amp;` -> `&`) which is how the link
            # appears in HTML email bodies.
            text = (em.get("text_body") or "") + "\n" + (em.get("html_body") or "")
            # Normalize HTML entities — Supabase's email template uses &amp;
            text = text.replace("&amp;", "&")
            verify_url = self._extract_verify_url(text)
            if not verify_url:
                log.debug(
                    "Email id=%s subject=%r matched but no verify URL in body",
                    em.get("id"), em.get("subject"),
                )
                continue
            # Parse the token + type from the URL
            parsed = parse_qs(urlparse(verify_url).query)
            token = (parsed.get("token", [""])[0] or "").strip()
            verify_type = (parsed.get("type", ["signup"])[0] or "signup").strip()
            if not token:
                log.warning("Verify URL found but no `token` param: %s", verify_url[:200])
                continue
            return VerificationEmail(
                id=int(em["id"]),
                message_id=em.get("message_id", ""),
                from_address=em.get("from_address", ""),
                to_address=em.get("to_address", ""),
                subject=em.get("subject", ""),
                received_at=em.get("received_at", ""),
                raw_size=int(em.get("raw_size") or 0),
                verify_url=verify_url,
                token=token,
                verify_type=verify_type,
            )
        return None

    def wait_for_verify_link(
        self, address: str, *,
        timeout: float = 180.0,
        poll_interval: float = 3.0,
        since: float | None = None,
    ) -> VerificationEmail:
        """Poll the inbox until a verification email arrives, then return it.

        Raises TimeoutError if no verification email arrives within `timeout`
        seconds.
        """
        if since is None:
            since = time.time() - 5  # small clock-skew tolerance
        deadline = time.time() + timeout
        attempt = 0
        last_err: Exception | None = None
        while time.time() < deadline:
            attempt += 1
            try:
                v = self.find_verification_email(address, since=since)
                if v is not None:
                    log.info(
                        "Verification link for %s found on attempt %d (id=%d, token=%s...)",
                        address, attempt, v.id, v.token[:12],
                    )
                    return v
            except EmailWorkerError as e:
                last_err = e
                log.warning("Email worker error on attempt %d: %s", attempt, e)
            time.sleep(poll_interval)
        msg = (
            f"No verification email for {address!r} within {timeout:.0f}s "
            f"(polled {attempt} times)"
        )
        if last_err:
            msg += f"; last error: {last_err}"
        raise TimeoutError(msg)

    # ------------------------------------------------------------------ #
    # Misc
    # ------------------------------------------------------------------ #
    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "EmailWorkerClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ------------------------------------------------------------------ #
    # Private
    # ------------------------------------------------------------------ #
    @staticmethod
    def _extract_verify_url(text: str) -> str | None:
        """Find the first verify URL in the text. Returns the URL or None.

        We return the raw match (with any HTML entities already normalized
        by the caller). The URL may include the `redirect_to` param — that's
        fine; the SignupClient strips it before calling the verify endpoint.
        """
        m = VERIFY_LINK_PATTERN.search(text)
        if m:
            # Strip trailing punctuation that may have been captured
            url = m.group(0).rstrip(".,);]")
            return url
        return None


__all__ = [
    "EmailWorkerClient",
    "EmailWorkerError",
    "VerificationEmail",
    "VERIFY_LINK_PATTERN",
]
