"""
Supabase signup client - creates a new account via the email+password
signup endpoint and verifies the email by following the verify link.

The flow is:

  1. `POST https://api.supabase.com/platform/signup`
     Body: `{"email": "...", "password": "...", "hcaptchaToken": "P1_..."}`
     Returns: 201 (empty body) on success.
     **Requires hCaptcha** - the token is validated server-side.

  2. Supabase sends a verification email to the address. The email contains
     a link like:
       https://auth.supabase.io/auth/v1/verify?token=...&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in

  3. `GET https://auth.supabase.io/auth/v1/verify?token=...&type=signup`
     Returns: 303 with `Location: https://app.supabase.com#access_token=<JWT>&refresh_token=...&expires_in=1800&token_type=bearer&type=signup`

     The access_token (JWT) is in the URL fragment. We parse it from the
     Location header - NO browser needed.

BUG WORKAROUND - redirect_to param
----------------------------------
The email's verify link includes `redirect_to=https://supabase.com/dashboard/sign-in`.
If you hit the verify URL WITH this param, the redirect target ends up
showing:
  {"code":400,"error_code":"validation_failed","msg":"Verify requires a verification type"}

If you remove `redirect_to`, the verify endpoint redirects to
`https://app.supabase.com#access_token=...` which works correctly.

So we ALWAYS strip `redirect_to` from the verify URL before calling the
endpoint. This is a Supabase-side bug; the workaround is documented in
docs/reverse-engineering-notes.md.

CRITICAL - hCaptcha is required for signup
------------------------------------------
Step 1 (`POST /platform/signup`) requires an hCaptcha `hcaptchaToken`. The
web app gets this token from hCaptcha's JS SDK (loaded from
`https://js.hcaptcha.com/1/api.js`). The token is short-lived (~2 minutes)
and tied to the browser's fingerprint.

Based on initial probing, Supabase's signup endpoint does NOT have a
Cloudflare WAF blocking datacenter IPs - it returns a JSON 401 for invalid
captcha tokens. However, the hCaptcha validation is server-side, and we
don't yet know whether Supabase uses hCaptcha enterprise mode (which
would reject headless browser tokens for signup, like Notion does).

The library supports three signup modes:
  1. **Manual captcha token**: solve the captcha in a real browser,
     copy the `P1_...` token from devtools, and pass it to
     `signup_and_verify(challenge_token=...)` within 2 minutes.
  2. **Headless captcha**: use `agent-browser` or Playwright to obtain an
     hCaptcha token from a headless browser. May fail if Supabase uses
     hCaptcha enterprise mode.
  3. **Browser extension bridge**: use the Chrome extension bridge
     (`signup_ext.py`) to drive a real browser through the signup form.
     This is the most reliable but requires the extension to be loaded.

After signup, the email verify + all subsequent platform API calls work
with plain `requests` - NO browser needed.
"""

from __future__ import annotations

import os
import time
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse, parse_qs, unquote

import requests

from .email_worker import EmailWorkerClient, VerificationEmail
from ..exceptions import (
    SupabaseAPIError,
    SupabaseAuthError,
    SupabaseSignupError,
    SupabaseVerifyError,
)

log = logging.getLogger("supabase_onboarding.signup.client")

DEFAULT_SIGNUP_URL = "https://api.supabase.com/platform/signup"
DEFAULT_VERIFY_URL_TEMPLATE = "https://auth.supabase.io/auth/v1/verify?token={token}&type={type}"
DEFAULT_USER_URL = "https://auth.supabase.io/auth/v1/user"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)


@dataclass
class SignupResult:
    """Result of a successful signup + email verification."""

    user_id: str          # the gotrue user UUID (from /auth/v1/user)
    email: str
    email_confirmed_at: str = ""
    access_token: str = ""        # short-lived JWT (30 min)
    refresh_token: str = ""
    expires_at: int = 0           # epoch seconds when access_token expires
    expires_in: int = 0           # seconds until expiry (usually 1800)
    token_type: str = "bearer"
    verify_type: str = "signup"
    raw_user: dict = field(default_factory=dict)  # full /auth/v1/user response

    @property
    def is_verified(self) -> bool:
        return bool(self.email_confirmed_at)


class SignupClient:
    """
    HTTP client for the Supabase email+password signup + verify flow.

    Example (manual captcha token - simplest path):
        >>> sc = SignupClient()
        >>> result = sc.signup_and_verify(
        ...     email="user@privatimail.com",
        ...     password="StrongPassword123!",
        ...     challenge_token="<P1_eyJ... from browser devtools>",
        ...     email_worker=EmailWorkerClient(base_url=..., token=...),
        ... )

    Example (headless captcha token - try this first):
        >>> from agent_browser import get_hcaptcha_token
        >>> token = get_hcaptcha_token("https://supabase.com/dashboard/sign-up")
        >>> result = sc.signup_and_verify(..., challenge_token=token, ...)
    """

    def __init__(
        self,
        *,
        signup_url: str = DEFAULT_SIGNUP_URL,
        user_url: str = DEFAULT_USER_URL,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ):
        self.signup_url = signup_url
        self.user_url = user_url
        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": "https://supabase.com",
            "Referer": "https://supabase.com/dashboard/sign-up",
            "User-Agent": user_agent,
            # Chrome sec-* headers - supabase's CDN edge may check these.
            "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "accept-language": "en-US,en;q=0.9",
            "priority": "u=1, i",
        })

    # ------------------------------------------------------------------ #
    # Step 1: POST /platform/signup (requires hCaptcha challengeToken)
    # ------------------------------------------------------------------ #
    def signup(
        self,
        email: str,
        password: str,
        challenge_token: str,
    ) -> None:
        """POST /platform/signup - create a new Supabase account.

        The `challenge_token` must come from hCaptcha's JS SDK. See module
        docstring for the three ways to obtain one.

        Returns: None (the endpoint returns 201 with empty body on success).

        Raises:
            SupabaseSignupError: if the captcha token is invalid, the email
                is already registered, the password is too weak, etc.
        """
        if not challenge_token:
            raise SupabaseSignupError(
                "challenge_token (hCaptcha) is required for signup. "
                "Get one from hCaptcha's JS SDK in a real browser, "
                "or use the browser extension bridge (signup_ext)."
            )
        body = {
            "email": email,
            "password": password,
            "hcaptchaToken": challenge_token,
        }
        log.info("Sending signup request for %s", email)
        r = self._session.post(self.signup_url, json=body, timeout=self.timeout)
        if r.status_code == 201:
            log.info("Signup OK for %s (201)", email)
            return
        # Error cases
        try:
            err = r.json()
        except Exception:
            err = {"message": r.text}
        msg = err.get("message") or err.get("msg") or f"HTTP {r.status_code}"
        # Detect specific known errors
        if "captcha" in msg.lower():
            raise SupabaseSignupError(
                f"Signup rejected: hCaptcha token invalid or rejected. {msg} "
                f"If using a headless browser token, Supabase may use hCaptcha "
                f"enterprise mode (like Notion) - solve the captcha manually in "
                f"a real browser and pass the resulting P1_... token.",
                status_code=r.status_code, payload=err,
            )
        if "already exists" in msg.lower():
            raise SupabaseSignupError(
                f"Signup rejected: {msg} "
                f"(the email is already registered - use login instead, "
                f"or pick a different email).",
                status_code=r.status_code, payload=err,
            )
        if "weak" in msg.lower() or "easy to guess" in msg.lower():
            raise SupabaseSignupError(
                f"Signup rejected: password too weak. {msg} "
                f"Use at least 12 chars with upper/lower/digit/symbol.",
                status_code=r.status_code, payload=err,
            )
        raise SupabaseSignupError(
            f"Signup failed: {msg}",
            status_code=r.status_code, payload=err,
        )

    # ------------------------------------------------------------------ #
    # Step 2: GET /auth/v1/verify (parse access_token from redirect)
    # ------------------------------------------------------------------ #
    def verify_email(
        self,
        verify_url: str | None = None,
        *,
        token: str | None = None,
        verify_type: str = "signup",
    ) -> dict:
        """GET /auth/v1/verify - follow the verify link and capture the
        access_token from the 303 redirect Location header.

        You can pass either:
          - `verify_url`: the full URL from the email (we'll strip redirect_to)
          - `token` + `verify_type`: just the token + type

        Returns a dict with: access_token, refresh_token, expires_at,
        expires_in, token_type, type.

        IMPORTANT: We strip the `redirect_to` query param from the URL
        before calling the endpoint. This is a workaround for a Supabase-side
        bug where the redirect_to URL causes the dashboard to show
        "Verify requires a verification type". See module docstring.

        Raises:
            SupabaseVerifyError: if the token is invalid/expired, or the
                response doesn't contain an access_token.
        """
        # Build the URL - strip redirect_to
        if verify_url:
            parsed = urlparse(verify_url)
            qs = parse_qs(parsed.query)
            # Drop redirect_to (the bug) and rebuild the query string
            qs.pop("redirect_to", None)
            qs.pop("redirect_to[]", None)  # just in case
            # Rebuild manually to control encoding
            token_val = (qs.get("token", [""])[0] or "").strip()
            type_val = (qs.get("type", [verify_type])[0] or verify_type).strip()
            if not token_val:
                raise SupabaseVerifyError(
                    f"No `token` param in verify URL: {verify_url[:200]}"
                )
            url = f"https://auth.supabase.io/auth/v1/verify?token={token_val}&type={type_val}"
        else:
            if not token:
                raise SupabaseVerifyError("Either verify_url or token is required")
            url = f"https://auth.supabase.io/auth/v1/verify?token={token}&type={verify_type}"

        log.info("Verifying email (token=%s...)", url.split("token=")[-1][:12])
        # Don't follow redirects - we want to parse the Location header
        r = self._session.get(url, allow_redirects=False, timeout=self.timeout)
        if r.status_code != 303:
            # Check for known error in the redirect target
            if r.status_code == 200 and "error" in r.text.lower():
                raise SupabaseVerifyError(
                    f"Verify returned 200 with error body: {r.text[:300]}"
                )
            raise SupabaseVerifyError(
                f"Verify returned unexpected status {r.status_code}: {r.text[:300]}",
                status_code=r.status_code, payload=r.text,
            )
        location = r.headers.get("Location") or r.headers.get("location")
        if not location:
            raise SupabaseVerifyError(
                "Verify returned 303 but no Location header",
                status_code=303,
            )
        # Parse the fragment (after #) which contains access_token=...&refresh_token=...
        if "#" not in location:
            # Check if it's an error redirect
            parsed = urlparse(location)
            qs = parse_qs(parsed.query)
            if "error" in qs:
                raise SupabaseVerifyError(
                    f"Verify redirected with error: {qs.get('error_description', qs.get('error'))[0]}",
                    status_code=303, payload=dict(qs),
                )
            raise SupabaseVerifyError(
                f"Verify Location has no fragment (no access_token): {location[:300]}",
                status_code=303,
            )
        fragment = location.split("#", 1)[1]
        params = parse_qs(fragment)
        access_token = (params.get("access_token", [""])[0] or "").strip()
        if not access_token:
            raise SupabaseVerifyError(
                f"Verify redirect fragment has no access_token: {fragment[:300]}",
                status_code=303,
            )
        result = {
            "access_token": access_token,
            "refresh_token": (params.get("refresh_token", [""])[0] or "").strip(),
            "expires_at": int(params.get("expires_at", [0])[0] or 0),
            "expires_in": int(params.get("expires_in", [0])[0] or 0),
            "token_type": (params.get("token_type", ["bearer"])[0] or "bearer").strip(),
            "type": (params.get("type", [verify_type])[0] or verify_type).strip(),
        }
        log.info(
            "Verify OK: access_token=%s... expires_in=%ds refresh_token=%s...",
            result["access_token"][:20], result["expires_in"],
            result["refresh_token"][:12],
        )
        return result

    # ------------------------------------------------------------------ #
    # Step 3: GET /auth/v1/user (optional - confirms the session works)
    # ------------------------------------------------------------------ #
    def get_user(self, access_token: str) -> dict:
        """GET /auth/v1/user - fetch the user object for the access_token.

        Requires the access_token from `verify_email`. Returns the full
        user object (id, email, email_confirmed_at, etc.).
        """
        r = self._session.get(
            self.user_url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "x-client-info": "gotrue-js/2.112.3",
                "Origin": "https://supabase.com",
                "Referer": "https://supabase.com/",
            },
            timeout=self.timeout,
        )
        if r.status_code == 403:
            try:
                err = r.json()
            except Exception:
                err = {"msg": r.text}
            raise SupabaseAuthError(
                f"get_user auth failed: {err.get('msg', 'unknown')}",
                status_code=403, payload=err,
            )
        if not r.ok:
            try:
                err = r.json()
            except Exception:
                err = {"text": r.text}
            raise SupabaseAPIError(
                f"get_user failed: HTTP {r.status_code}",
                status_code=r.status_code, payload=err,
            )
        return r.json()

    # ------------------------------------------------------------------ #
    # Convenience: full signup -> verify email flow
    # ------------------------------------------------------------------ #
    def signup_and_verify(
        self,
        email: str,
        password: str,
        challenge_token: str,
        email_worker: EmailWorkerClient,
        *,
        email_wait_timeout: float = 180.0,
    ) -> SignupResult:
        """End-to-end signup + verify: signup -> poll email worker for the
        verify link -> follow the link -> fetch the user object.

        **Requires `challenge_token`** - an hCaptcha token. See module
        docstring for the three ways to obtain one.

        Returns the SignupResult with `access_token` populated.
        """
        log.info("Starting signup-and-verify flow for %s", email)
        # Step 1: signup
        self.signup(email, password, challenge_token)

        # Step 2: poll for the verify email
        log.info("Waiting for verification email at %s (timeout=%ds)",
                 email, int(email_wait_timeout))
        v: VerificationEmail = email_worker.wait_for_verify_link(
            email, timeout=email_wait_timeout,
        )
        log.info("Got verify email (id=%d, token=%s...); following link",
                 v.id, v.token[:12])

        # Step 3: follow the verify link (strips redirect_to automatically)
        tokens = self.verify_email(verify_url=v.verify_url)

        # Step 4: fetch the user object (confirms the session works + gets user_id)
        user = self.get_user(tokens["access_token"])

        return SignupResult(
            user_id=user.get("id", ""),
            email=user.get("email", email),
            email_confirmed_at=user.get("email_confirmed_at", ""),
            access_token=tokens["access_token"],
            refresh_token=tokens["refresh_token"],
            expires_at=tokens["expires_at"],
            expires_in=tokens["expires_in"],
            token_type=tokens["token_type"],
            verify_type=tokens["type"],
            raw_user=user,
        )

    # ------------------------------------------------------------------ #
    # Convenience: verify-only flow (for an existing account that just needs
    # to re-verify, or for resuming a signup that already happened)
    # ------------------------------------------------------------------ #
    def verify_only(
        self,
        email: str,
        email_worker: EmailWorkerClient,
        *,
        email_wait_timeout: float = 180.0,
    ) -> SignupResult:
        """Skip signup (assume it already happened) and just poll for the
        verify email + follow the link.

        Useful for resuming a partially-completed signup, or for re-logging
        in to an existing account via the magic-link flow.
        """
        log.info("Waiting for verification email at %s", email)
        v = email_worker.wait_for_verify_link(email, timeout=email_wait_timeout)
        tokens = self.verify_email(verify_url=v.verify_url)
        user = self.get_user(tokens["access_token"])
        return SignupResult(
            user_id=user.get("id", ""),
            email=user.get("email", email),
            email_confirmed_at=user.get("email_confirmed_at", ""),
            access_token=tokens["access_token"],
            refresh_token=tokens["refresh_token"],
            expires_at=tokens["expires_at"],
            expires_in=tokens["expires_in"],
            token_type=tokens["token_type"],
            verify_type=tokens["type"],
            raw_user=user,
        )

    # ------------------------------------------------------------------ #
    # Misc
    # ------------------------------------------------------------------ #
    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "SignupClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


__all__ = ["SignupClient", "SignupResult"]
