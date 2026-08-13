"""
JWT token manager for Supabase dashboard API access.

The JWT (access_token) from the verify flow expires in 30 minutes.
The refresh_token (also from verify) can be used to get a fresh JWT
via GoTrue's /auth/v1/token?grant_type=refresh_token endpoint.

The refresh_token ROTATES on each refresh — the old one is invalidated
and a new one is returned. We must store the latest refresh_token.

Usage:
    from supabase_onboarding.token_manager import TokenManager

    tm = TokenManager(access_token=jwt, refresh_token=refresh)
    # ... later, when JWT might be expired ...
    tokens = tm.get_valid_tokens()
    # tokens['access_token'] is guaranteed to be valid (refreshed if needed)
    jwt = tokens['access_token']

For the worker, tokens can be stored in D1 and refreshed on demand.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import requests

log = logging.getLogger("supabase_onboarding.token_manager")

# The Supabase platform anon key (public, used for the auth endpoint)
# This is the same key the dashboard uses — it's not secret.
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1cGFidGFzZSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNjQ1NzI4MDAwLCJleHAiOjIwMDAwMDAwMDB9."
    "XQQwMjyZmhQOjG3iG8pT"
)

AUTH_BASE = "https://auth.supabase.io/auth/v1"


@dataclass
class TokenSet:
    """A set of JWT + refresh token + metadata."""

    access_token: str
    refresh_token: str
    expires_at: int = 0  # epoch seconds
    expires_in: int = 0  # seconds until expiry (usually 1800 = 30 min)
    token_type: str = "bearer"

    @property
    def is_expired(self) -> bool:
        """True if the access_token has expired (with 60s safety margin)."""
        if not self.expires_at:
            return True
        return time.time() > (self.expires_at - 60)

    def to_dict(self) -> dict:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "expires_in": self.expires_in,
            "token_type": self.token_type,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TokenSet":
        return cls(
            access_token=d.get("access_token", ""),
            refresh_token=d.get("refresh_token", ""),
            expires_at=int(d.get("expires_at", 0)),
            expires_in=int(d.get("expires_in", 0)),
            token_type=d.get("token_type", "bearer"),
        )


class TokenManager:
    """
    Manages JWT refresh lifecycle.

    Usage:
        tm = TokenManager(access_token=jwt, refresh_token=refresh)
        tokens = tm.get_valid_tokens()  # refreshes if expired
        jwt = tokens.access_token
    """

    def __init__(
        self,
        access_token: str = "",
        refresh_token: str = "",
        expires_at: int = 0,
        expires_in: int = 0,
        *,
        anon_key: str = SUPABASE_ANON_KEY,
        timeout: float = 15.0,
    ):
        self._tokens = TokenSet(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=expires_at,
            expires_in=expires_in,
        )
        self.anon_key = anon_key
        self.timeout = timeout

    @classmethod
    def from_dict(cls, d: dict) -> "TokenManager":
        ts = TokenSet.from_dict(d)
        return cls(
            access_token=ts.access_token,
            refresh_token=ts.refresh_token,
            expires_at=ts.expires_at,
            expires_in=ts.expires_in,
        )

    def to_dict(self) -> dict:
        return self._tokens.to_dict()

    @property
    def access_token(self) -> str:
        return self._tokens.access_token

    @property
    def refresh_token(self) -> str:
        return self._tokens.refresh_token

    @property
    def is_expired(self) -> bool:
        return self._tokens.is_expired

    def get_valid_tokens(self) -> TokenSet:
        """Return valid tokens, refreshing if the JWT is expired.

        If the JWT is still valid, returns immediately.
        If expired, calls refresh() to get a new JWT + refresh_token.
        """
        if not self._tokens.is_expired:
            return self._tokens
        return self.refresh()

    def refresh(self) -> TokenSet:
        """Refresh the JWT using the refresh_token.

        The refresh_token ROTATES — the old one is invalidated and a new
        one is returned. We update self._tokens with the new set.

        Returns the new TokenSet.

        Raises:
            RuntimeError: if the refresh fails (e.g. refresh_token expired).
        """
        if not self._tokens.refresh_token:
            raise RuntimeError("No refresh_token — cannot refresh JWT")

        log.info("Refreshing JWT (refresh_token=%s...)", self._tokens.refresh_token[:12])
        r = requests.post(
            f"{AUTH_BASE}/token?grant_type=refresh_token",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.anon_key}",
                "x-client-info": "gotrue-js/2.112.3",
            },
            json={"refresh_token": self._tokens.refresh_token},
            timeout=self.timeout,
        )
        if not r.ok:
            raise RuntimeError(
                f"JWT refresh failed: HTTP {r.status_code}: {r.text[:300]}"
            )
        data = r.json()
        self._tokens = TokenSet(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=int(data.get("expires_at", 0)),
            expires_in=int(data.get("expires_in", 1800)),
            token_type=data.get("token_type", "bearer"),
        )
        log.info(
            "JWT refreshed: access_token=%s... expires_in=%ds refresh_token=%s...",
            self._tokens.access_token[:20],
            self._tokens.expires_in,
            self._tokens.refresh_token[:12],
        )
        return self._tokens

    def auth_headers(self, extra: dict | None = None) -> dict:
        """Return Authorization headers with a valid JWT.

        Automatically refreshes if the JWT is expired.
        """
        tokens = self.get_valid_tokens()
        headers = {"Authorization": f"Bearer {tokens.access_token}"}
        if extra:
            headers.update(extra)
        return headers


__all__ = ["TokenManager", "TokenSet", "SUPABASE_ANON_KEY"]
