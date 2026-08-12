"""
Platform profile operations.

POST /platform/profile - creates the platform profile (links the gotrue
auth user to a platform account). Returns the profile with id, gotrue_id,
primary_email, free_project_limit, etc.

GET /platform/profile - returns the existing profile, or 404 if not yet
created.

This step MUST be done before creating an organization or PAT - the
platform API needs a profile record to associate resources with.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .client import SupabasePlatformClient
from .exceptions import SupabaseAPIError, SupabaseAuthError

log = logging.getLogger("supabase_onboarding.profile")


@dataclass
class PlatformProfile:
    """A Supabase platform profile."""

    id: int                       # platform numeric ID (e.g. 16327969)
    gotrue_id: str                # the auth user UUID
    auth0_id: str                 # "email|<gotrue_id>" (legacy field)
    primary_email: str
    username: str
    first_name: str | None = None
    last_name: str | None = None
    mobile: str | None = None
    is_alpha_user: bool = False
    is_sso_user: bool = False
    free_project_limit: int = 2
    disabled_features: list[str] | None = None
    raw: dict | None = None


def _parse_profile(data: dict) -> PlatformProfile:
    return PlatformProfile(
        id=int(data.get("id", 0)),
        gotrue_id=data.get("gotrue_id", ""),
        auth0_id=data.get("auth0_id", ""),
        primary_email=data.get("primary_email", ""),
        username=data.get("username", ""),
        first_name=data.get("first_name"),
        last_name=data.get("last_name"),
        mobile=data.get("mobile"),
        is_alpha_user=bool(data.get("is_alpha_user", False)),
        is_sso_user=bool(data.get("is_sso_user", False)),
        free_project_limit=int(data.get("free_project_limit", 2)),
        disabled_features=data.get("disabled_features") or [],
        raw=data,
    )


def create_profile(client: SupabasePlatformClient) -> PlatformProfile:
    """POST /platform/profile - create the platform profile for the
    authenticated user.

    The request body is empty - the server derives everything from the
    JWT/PAT.

    Returns the created PlatformProfile.

    Raises:
        SupabaseAPIError: if the profile already exists (400) or other error.
        SupabaseAuthError: if the token is invalid.
    """
    log.info("Creating platform profile")
    data = client.post("/platform/profile", json_body={})
    if not data:
        raise SupabaseAPIError(
            "POST /platform/profile returned empty body",
            status_code=201,
        )
    profile = _parse_profile(data)
    log.info(
        "Profile created: id=%d gotrue_id=%s email=%s free_project_limit=%d",
        profile.id, profile.gotrue_id, profile.primary_email,
        profile.free_project_limit,
    )
    return profile


def get_profile(client: SupabasePlatformClient) -> PlatformProfile | None:
    """GET /platform/profile - fetch the current user's profile.

    Returns the PlatformProfile, or None if the profile doesn't exist yet
    (HTTP 404).
    """
    data = client.get("/platform/profile")
    if not data:
        return None
    return _parse_profile(data)


def get_or_create_profile(client: SupabasePlatformClient) -> PlatformProfile:
    """Fetch the profile; if it doesn't exist, create it. Idempotent."""
    profile = get_profile(client)
    if profile is not None:
        log.info("Profile exists: id=%d email=%s", profile.id, profile.primary_email)
        return profile
    return create_profile(client)


__all__ = [
    "PlatformProfile",
    "create_profile",
    "get_profile",
    "get_or_create_profile",
]
