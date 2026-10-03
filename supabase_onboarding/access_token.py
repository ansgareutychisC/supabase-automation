"""
Personal Access Token (PAT) operations.

POST /platform/profile/access-tokens - create a new PAT.
GET /platform/profile/access-tokens - list existing PATs (token value is
  NOT returned by the list endpoint - only the masked `token_alias`).

The PAT is the golden output of the onboarding flow. With a PAT
(`sbp_...`), you can:
  - Use the Supabase CLI (`supabase login --token sbp_...`)
  - Call the Management API directly (`Authorization: Bearer sbp_...`)
  - Create projects, manage databases, etc. - all without the browser

The PAT replaces the short-lived JWT (30 min) with a long-lived token
(configurable expiry - default 30 days in the dashboard, but the API
accepts any ISO 8601 timestamp).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .client import SupabasePlatformClient
from .exceptions import SupabaseAPIError

log = logging.getLogger("supabase_onboarding.access_token")


@dataclass
class AccessToken:
    """A Supabase Personal Access Token (PAT)."""

    id: int
    name: str
    token: str                   # the full sbp_... token (ONLY on creation)
    token_alias: str             # masked version, e.g. "sbp_***••••••***"
    created_at: str              # ISO 8601
    expires_at: str              # ISO 8601
    last_used_at: str | None = None
    raw: dict | None = None


def _parse_token(data: dict) -> AccessToken:
    return AccessToken(
        id=int(data.get("id", 0)),
        name=data.get("name", ""),
        token=data.get("token", ""),  # only present on POST response
        token_alias=data.get("token_alias", ""),
        created_at=data.get("created_at", ""),
        expires_at=data.get("expires_at", ""),
        last_used_at=data.get("last_used_at"),
        raw=data,
    )


def create_access_token(
    client: SupabasePlatformClient,
    *,
    name: str = "automation-token",
    expires_at: datetime | None = None,
    expires_in_days: int | None = 30,
) -> AccessToken:
    """POST /platform/profile/access-tokens - create a new PAT.

    Args:
        client: the SupabasePlatformClient (with JWT or PAT)
        name: human-readable name for the token (shown in dashboard)
        expires_at: explicit expiry datetime (timezone-aware recommended).
            If None, computed from `expires_in_days`.
        expires_in_days: days until expiry (default 30). Ignored if
            `expires_at` is provided.

    Returns the AccessToken with the full `sbp_...` token in `.token`.
    This is the only time the full token is returned - save it somewhere
    safe.

    The PAT can then be used to construct a new SupabasePlatformClient
    for all future operations, replacing the short-lived JWT.
    """
    if expires_at is None:
        if expires_in_days is None:
            expires_in_days = 30
        expires_at = datetime.now(timezone.utc) + timedelta(days=expires_in_days)
    # Format as ISO 8601 with milliseconds + Z (matches dashboard's format)
    expires_at_str = expires_at.strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{expires_at.microsecond // 1000:03d}Z"

    body = {"name": name, "expires_at": expires_at_str}
    log.info("Creating PAT name=%r expires_at=%s", name, expires_at_str)
    data = client.post("/platform/profile/access-tokens", json_body=body)
    if not data:
        raise SupabaseAPIError(
            "POST /platform/profile/access-tokens returned empty body",
            status_code=201,
        )
    token = _parse_token(data)
    if not token.token:
        raise SupabaseAPIError(
            "PAT created but no `token` field in response (this is a bug)",
            status_code=201, payload=data,
        )
    log.info(
        "PAT created: id=%d name=%r alias=%s expires_at=%s",
        token.id, token.name, token.token_alias, token.expires_at,
    )
    return token


def list_access_tokens(client: SupabasePlatformClient) -> list[AccessToken]:
    """GET /platform/profile/access-tokens - list all PATs.

    NOTE: The list endpoint does NOT return the full `token` value - only
    the masked `token_alias`. To get the full token, you must capture it
    at creation time (from `create_access_token`'s return value).
    """
    data = client.get("/platform/profile/access-tokens")
    if not data:
        return []
    return [_parse_token(t) for t in data]


def delete_access_token(client: SupabasePlatformClient, token_id: int) -> None:
    """DELETE /platform/profile/access-tokens/:id - revoke a PAT."""
    client.delete(f"/platform/profile/access-tokens/{token_id}")
    log.info("PAT deleted: id=%d", token_id)


__all__ = [
    "AccessToken",
    "create_access_token",
    "list_access_tokens",
    "delete_access_token",
]
