"""
Organization operations.

POST /platform/organizations - create a new organization.
GET /platform/organizations - list the user's organizations.

The first organization is typically created right after signup+verify, as
a "PERSONAL" org with the free tier. Projects live inside organizations.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .client import SupabasePlatformClient
from .exceptions import SupabaseAPIError

log = logging.getLogger("supabase_onboarding.organization")


@dataclass
class Organization:
    """A Supabase organization."""

    id: int
    slug: str                       # the org slug used in URLs / API paths
    name: str
    billing_email: str
    is_owner: bool
    plan_id: str                    # "free", "pro", "team", "enterprise"
    plan_name: str
    stripe_customer_id: str | None = None
    subscription_id: str | None = None
    raw: dict | None = None


def _parse_org(data: dict) -> Organization:
    plan = data.get("plan") or {}
    return Organization(
        id=int(data.get("id", 0)),
        slug=data.get("slug", ""),
        name=data.get("name", ""),
        billing_email=data.get("billing_email", ""),
        is_owner=bool(data.get("is_owner", False)),
        plan_id=str(plan.get("id", "")),
        plan_name=str(plan.get("name", "")),
        stripe_customer_id=data.get("stripe_customer_id"),
        subscription_id=data.get("subscription_id"),
        raw=data,
    )


def create_organization(
    client: SupabasePlatformClient,
    *,
    name: str,
    kind: str = "PERSONAL",
    tier: str = "tier_free",
) -> Organization:
    """POST /platform/organizations - create a new organization.

    Args:
        client: the SupabasePlatformClient (with JWT or PAT)
        name: org name (e.g. "user@example.com's Org")
        kind: "PERSONAL" (default) or "BUSINESS" - check the dashboard
              for valid values; PERSONAL is the default for new accounts
        tier: "tier_free" (default), "tier_pro", "tier_team", "tier_enterprise"

    Returns the created Organization.

    The HAR shows the dashboard creating a PERSONAL free-tier org named
    "<email>'s Org" right after signup. This is the default behavior
    when the user lands on /dashboard/new for the first time.
    """
    log.info("Creating organization name=%r kind=%s tier=%s", name, kind, tier)
    body = {"name": name, "kind": kind, "tier": tier}
    data = client.post("/platform/organizations", json_body=body)
    if not data:
        raise SupabaseAPIError(
            "POST /platform/organizations returned empty body",
            status_code=201,
        )
    org = _parse_org(data)
    log.info(
        "Org created: id=%d slug=%s plan=%s",
        org.id, org.slug, org.plan_id,
    )
    return org


def list_organizations(client: SupabasePlatformClient) -> list[Organization]:
    """GET /platform/organizations - list all organizations the user belongs to.

    Returns an empty list if the user has no organizations yet (e.g. just
    signed up and hasn't created one).
    """
    data = client.get("/platform/organizations")
    if not data:
        return []
    return [_parse_org(o) for o in data]


def get_or_create_personal_org(
    client: SupabasePlatformClient,
    *,
    name_hint: str | None = None,
) -> Organization:
    """Fetch the first org; if none exist, create a PERSONAL free-tier org.

    `name_hint` is used as the org name when creating. If None, defaults
    to "<email>'s Org" (matching the dashboard's behavior).
    """
    orgs = list_organizations(client)
    if orgs:
        log.info("Org exists: id=%d slug=%s", orgs[0].id, orgs[0].slug)
        return orgs[0]
    if not name_hint:
        # Try to get the email from the profile
        try:
            from .profile import get_profile
            profile = get_profile(client)
            if profile and profile.primary_email:
                name_hint = f"{profile.primary_email}'s Org"
            else:
                name_hint = "My Organization"
        except Exception:
            name_hint = "My Organization"
    return create_organization(client, name=name_hint, kind="PERSONAL", tier="tier_free")


__all__ = [
    "Organization",
    "create_organization",
    "list_organizations",
    "get_or_create_personal_org",
]
