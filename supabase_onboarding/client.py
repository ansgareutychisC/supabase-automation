"""
Supabase platform client - Bearer-auth HTTP client for api.supabase.com/platform/*.

After signup + email verify, you have a short-lived JWT `access_token`
(30 min expiry). Use this client to call platform endpoints with that
token, OR with a long-lived PAT (`sbp_...`) from
`/platform/profile/access-tokens`.

All endpoints accept `Authorization: Bearer <token>` and return JSON.
No cookies / WAF interaction needed - the platform API is a plain JSON API.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

from .exceptions import SupabaseAPIError, SupabaseAuthError

log = logging.getLogger("supabase_onboarding.client")

DEFAULT_BASE_URL = "https://api.supabase.com"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)


class SupabasePlatformClient:
    """
    Bearer-auth HTTP client for api.supabase.com/platform/*.

    Auth modes:
      - **JWT access_token** (short-lived, 30 min): from `SignupClient.verify_email()`
      - **PAT** (long-lived, configurable): `sbp_...` from `create_access_token()`

    Both work for the same endpoints. PAT is preferred for follow-up
    operations because it doesn't expire quickly.

    Example:
        >>> # With JWT (just signed up):
        >>> client = SupabasePlatformClient(access_token="<JWT>")
        >>> # With PAT (long-lived):
        >>> client = SupabasePlatformClient(access_token="sbp_...")
        >>>
        >>> profile = client.get("/platform/profile")
        >>> orgs = client.get("/platform/organizations")
    """

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ):
        if not access_token:
            raise ValueError("access_token is required")
        self.access_token = access_token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": user_agent,
            "Origin": "https://supabase.com",
            "Referer": "https://supabase.com/dashboard",
            # sec-* headers - matches what the dashboard sends
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
    # Low-level HTTP
    # ------------------------------------------------------------------ #
    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
        expect_json: bool = True,
    ) -> Any:
        """Issue a request to <base_url><path>. Returns parsed JSON (or None)."""
        url = f"{self.base_url}{path}" if path.startswith("/") else f"{self.base_url}/{path}"
        log.debug("-> %s %s params=%s json=%s", method, url, params, json_body)
        r = self._session.request(
            method, url,
            params=params,
            json=json_body if json_body is not None else None,
            timeout=self.timeout,
        )
        log.debug("<- %s %s", r.status_code, r.reason)

        if r.status_code in (401, 403):
            try:
                err = r.json()
            except Exception:
                err = {"message": r.text}
            msg = err.get("message") or err.get("msg") or f"HTTP {r.status_code}"
            raise SupabaseAuthError(
                f"{method} {path}: {msg}",
                status_code=r.status_code, payload=err,
            )
        if r.status_code == 404:
            # 404 is a valid response for some endpoints (e.g. profile before
            # it's been created). Return None instead of raising.
            return None
        if not (200 <= r.status_code < 300):
            try:
                err = r.json()
            except Exception:
                err = {"message": r.text}
            msg = err.get("message") or err.get("msg") or f"HTTP {r.status_code}"
            raise SupabaseAPIError(
                f"{method} {path}: {msg}",
                status_code=r.status_code, payload=err,
            )
        if not expect_json:
            return r.content
        if not r.content:
            return None
        try:
            return r.json()
        except Exception as e:
            raise SupabaseAPIError(
                f"{method} {path}: non-JSON response: {e}",
                status_code=r.status_code, payload=r.text[:500],
            ) from e

    def get(self, path: str, *, params: dict | None = None) -> Any:
        return self.request("GET", path, params=params)

    def post(self, path: str, *, json_body: dict | None = None,
             params: dict | None = None) -> Any:
        # Ensure Content-Type is set when there's a body
        if json_body is not None and "Content-Type" not in self._session.headers:
            self._session.headers["Content-Type"] = "application/json"
        return self.request("POST", path, params=params, json_body=json_body)

    def patch(self, path: str, *, json_body: dict | None = None) -> Any:
        return self.request("PATCH", path, json_body=json_body)

    def delete(self, path: str) -> Any:
        return self.request("DELETE", path)

    # ------------------------------------------------------------------ #
    # Auth helpers
    # ------------------------------------------------------------------ #
    def is_token_valid(self) -> bool:
        """Quick check: is the token valid?

        For JWT: GET /platform/profile returns 200 or 404 (both = valid)
        For PAT: GET /v1/organizations returns 200 (PATs don't work on /platform/*)
        """
        if self.token_kind == "pat":
            # PATs only work on /v1/* (public Management API)
            try:
                self.get("/v1/organizations")
                return True
            except (SupabaseAuthError, SupabaseAPIError):
                return False
        else:
            # JWTs work on /platform/*
            try:
                self.get("/platform/profile")
                return True
            except SupabaseAuthError:
                return False
            except SupabaseAPIError as e:
                if e.status_code == 404:
                    return True
                raise

    @property
    def token_kind(self) -> str:
        """Return 'pat' if the token looks like a PAT (sbp_...), else 'jwt'."""
        if self.access_token.startswith("sbp_"):
            return "pat"
        if self.access_token.startswith("eyJ"):
            return "jwt"
        return "unknown"

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "SupabasePlatformClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


__all__ = ["SupabasePlatformClient"]
