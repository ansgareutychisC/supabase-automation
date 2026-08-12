"""
High-level OnboardingAutomation facade - orchestrates the full signup ->
verify -> profile -> org -> PAT flow.

Two modes:
  1. Plain HTTP (manual captcha token): `OnboardingAutomation.from_signup()`
     + `run_full(challenge_token=...)` - you supply the hCaptcha token.
  2. Browser extension: `OnboardingAutomation.from_extension()`
     + `run_full_ext()` - the extension drives the signup form, the user
     solves the captcha in the browser, the rest is automated.

After `run_full()` / `run_full_ext()`, you get an `OnboardingReport` with:
  - user_id, email
  - access_token (short-lived JWT, 30 min)
  - refresh_token
  - pat (long-lived sbp_... token)
  - org_id, org_slug
  - profile_id

The PAT is the golden output - use it for all future operations.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field, asdict
from typing import Any

from .client import SupabasePlatformClient
from .signup.client import SignupClient, SignupResult
from .signup.email_worker import EmailWorkerClient
from .profile import PlatformProfile, get_or_create_profile
from .organization import Organization, get_or_create_personal_org
from .access_token import AccessToken, create_access_token

log = logging.getLogger("supabase_onboarding.onboarding")


@dataclass
class OnboardingReport:
    """The full result of an onboarding run."""

    # Signup + verify
    user_id: str = ""
    email: str = ""
    email_confirmed_at: str = ""
    access_token: str = ""          # short-lived JWT (30 min)
    refresh_token: str = ""
    expires_at: int = 0
    expires_in: int = 0

    # Platform profile
    profile_id: int = 0
    gotrue_id: str = ""
    free_project_limit: int = 2

    # Organization
    org_id: int = 0
    org_slug: str = ""
    org_name: str = ""
    plan_id: str = ""

    # PAT (the golden output)
    pat: str = ""                   # sbp_... long-lived token
    pat_id: int = 0
    pat_name: str = ""
    pat_alias: str = ""
    pat_expires_at: str = ""

    # Misc
    errors: list[str] = field(default_factory=list)
    raw_signup: dict = field(default_factory=dict)

    @property
    def is_success(self) -> bool:
        return bool(self.pat and self.org_slug)

    def as_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> str:
        lines = [
            "=== Supabase Onboarding Report ===",
            f"  Email:        {self.email}",
            f"  User ID:      {self.user_id}",
            f"  Profile ID:   {self.profile_id}",
            f"  Org:          {self.org_name} (slug={self.org_slug}, id={self.org_id})",
            f"  Plan:         {self.plan_id}",
            f"  Access Token: {self.access_token[:40]}... (expires in {self.expires_in}s)",
            f"  PAT:          {self.pat[:20]}...{self.pat[-8:] if len(self.pat) > 28 else ''}",
            f"  PAT expires:  {self.pat_expires_at}",
        ]
        if self.errors:
            lines.append(f"  Errors:       {len(self.errors)}")
            for e in self.errors:
                lines.append(f"    - {e}")
        return "\n".join(lines)


class OnboardingAutomation:
    """
    High-level facade for the full Supabase onboarding flow.

    Usage (plain HTTP - manual captcha token):
        >>> from supabase_onboarding import OnboardingAutomation, EmailWorkerClient
        >>> ew = EmailWorkerClient(base_url="...", token="...")
        >>> auto = OnboardingAutomation.for_signup(email_worker=ew)
        >>> report = auto.run_full(
        ...     email="user@privatimail.com",
        ...     password="StrongPassword123!",
        ...     challenge_token="<P1_eyJ... from browser devtools>",
        ... )
        >>> print(report.summary())
        >>> # Save the PAT for future use:
        >>> with open(".pat", "w") as f: f.write(report.pat)

    Usage (browser extension - full automation with manual captcha solve):
        >>> auto = OnboardingAutomation.for_extension(
        ...     email_worker=ew,
        ...     bridge_host="127.0.0.1", bridge_port=8787,
        ... )
        >>> report = await auto.run_full_ext(
        ...     email="user@privatimail.com",
        ...     password="StrongPassword123!",
        ... )
    """

    def __init__(
        self,
        *,
        email_worker: EmailWorkerClient | None,
        signup_client: SignupClient | None = None,
        platform_client: SupabasePlatformClient | None = None,
        extension_bridge: Any | None = None,
    ):
        self.email_worker = email_worker
        self.signup_client = signup_client or SignupClient()
        self.platform_client = platform_client
        self.extension_bridge = extension_bridge

    # ------------------------------------------------------------------ #
    # Constructors
    # ------------------------------------------------------------------ #
    @classmethod
    def for_signup(
        cls,
        *,
        email_worker: EmailWorkerClient,
        signup_client: SignupClient | None = None,
    ) -> "OnboardingAutomation":
        """Plain HTTP mode - you supply the hCaptcha token manually."""
        return cls(
            email_worker=email_worker,
            signup_client=signup_client or SignupClient(),
        )

    @classmethod
    def for_existing_token(
        cls,
        access_token: str,
    ) -> "OnboardingAutomation":
        """Operate on an existing account (JWT or PAT). No signup/verify."""
        client = SupabasePlatformClient(access_token=access_token)
        return cls(
            email_worker=None,
            platform_client=client,
        )

    @classmethod
    def for_extension(
        cls,
        *,
        email_worker: EmailWorkerClient,
        bridge_host: str = "127.0.0.1",
        bridge_port: int = 8787,
        bridge_auth_token: str = "",
    ) -> "OnboardingAutomation":
        """Browser extension mode - the extension drives the signup form."""
        from .extension_bridge import ExtensionBridge
        bridge = ExtensionBridge(
            host=bridge_host, port=bridge_port, auth_token=bridge_auth_token,
        )
        return cls(
            email_worker=email_worker,
            extension_bridge=bridge,
        )

    # ------------------------------------------------------------------ #
    # Plain HTTP flow
    # ------------------------------------------------------------------ #
    def run_full(
        self,
        *,
        email: str,
        password: str,
        challenge_token: str,
        org_name: str | None = None,
        pat_name: str = "automation-token",
        pat_expires_in_days: int = 30,
        email_wait_timeout: float = 180.0,
    ) -> OnboardingReport:
        """Full signup -> verify -> profile -> org -> PAT flow.

        Requires `challenge_token` (hCaptcha). See SignupClient.signup_and_verify
        for how to obtain one.

        Returns an OnboardingReport with all fields populated.
        """
        report = OnboardingReport(email=email)

        # Step 1+2+3: signup + verify email + get user
        try:
            result: SignupResult = self.signup_client.signup_and_verify(
                email, password, challenge_token,
                email_worker=self.email_worker,
                email_wait_timeout=email_wait_timeout,
            )
            report.user_id = result.user_id
            report.email = result.email
            report.email_confirmed_at = result.email_confirmed_at
            report.access_token = result.access_token
            report.refresh_token = result.refresh_token
            report.expires_at = result.expires_at
            report.expires_in = result.expires_in
            report.raw_signup = result.raw_user
        except Exception as e:
            log.error("Signup+verify failed: %s", e)
            report.errors.append(f"signup+verify: {e}")
            return report

        # Step 4: create platform profile (idempotent)
        self.platform_client = SupabasePlatformClient(access_token=result.access_token)
        try:
            profile: PlatformProfile = get_or_create_profile(self.platform_client)
            report.profile_id = profile.id
            report.gotrue_id = profile.gotrue_id
            report.free_project_limit = profile.free_project_limit
        except Exception as e:
            log.error("Profile creation failed: %s", e)
            report.errors.append(f"profile: {e}")
            return report

        # Step 5: create personal org (idempotent)
        try:
            org: Organization = get_or_create_personal_org(
                self.platform_client, name_hint=org_name,
            )
            report.org_id = org.id
            report.org_slug = org.slug
            report.org_name = org.name
            report.plan_id = org.plan_id
        except Exception as e:
            log.error("Org creation failed: %s", e)
            report.errors.append(f"org: {e}")
            return report

        # Step 6: generate PAT (the golden output)
        try:
            token: AccessToken = create_access_token(
                self.platform_client,
                name=pat_name,
                expires_in_days=pat_expires_in_days,
            )
            report.pat = token.token
            report.pat_id = token.id
            report.pat_name = token.name
            report.pat_alias = token.token_alias
            report.pat_expires_at = token.expires_at
        except Exception as e:
            log.error("PAT creation failed: %s", e)
            report.errors.append(f"pat: {e}")

        return report

    # ------------------------------------------------------------------ #
    # Extension-based flow
    # ------------------------------------------------------------------ #
    async def run_full_ext(
        self,
        *,
        email: str,
        password: str,
        org_name: str | None = None,
        pat_name: str = "automation-token",
        pat_expires_in_days: int = 30,
        email_wait_timeout: float = 180.0,
        captcha_wait_timeout: float = 300.0,
    ) -> OnboardingReport:
        """Extension-based signup -> verify -> profile -> org -> PAT.

        The extension drives the signup form. The user solves the hCaptcha
        in the browser. The rest is automated.

        Requires the bridge daemon (scripts/run_bridge_aiohttp.py) to be
        running and the extension to be loaded + connected.
        """
        if not self.extension_bridge:
            raise RuntimeError("ExtensionBridge not configured - use for_extension()")
        report = OnboardingReport(email=email)

        # Connect to the bridge daemon + wait for extension
        await self.extension_bridge.connect()
        await self.extension_bridge.wait_for_extension()

        # Step 1: drive the signup form via the extension
        try:
            signup_result = await self.extension_bridge.signup_with_extension(
                email, password, captcha_wait_timeout=captcha_wait_timeout,
            )
        except Exception as e:
            report.errors.append(f"extension signup: {e}")
            return report

        if not signup_result.get("ok"):
            report.errors.append(f"extension signup: {signup_result.get('error')}")
            return report

        # Step 2: poll for the verify email + follow the link (plain HTTP)
        if not self.email_worker:
            report.errors.append("email_worker not configured - cannot poll for verify email")
            return report
        try:
            v = self.email_worker.wait_for_verify_link(email, timeout=email_wait_timeout)
            tokens = self.signup_client.verify_email(verify_url=v.verify_url)
            user = self.signup_client.get_user(tokens["access_token"])
            report.user_id = user.get("id", "")
            report.email = user.get("email", email)
            report.email_confirmed_at = user.get("email_confirmed_at", "")
            report.access_token = tokens["access_token"]
            report.refresh_token = tokens["refresh_token"]
            report.expires_at = tokens["expires_at"]
            report.expires_in = tokens["expires_in"]
            report.raw_signup = user
        except Exception as e:
            log.error("Verify+get_user failed: %s", e)
            report.errors.append(f"verify: {e}")
            return report

        # Step 3-5: profile + org + PAT (same as plain HTTP)
        self.platform_client = SupabasePlatformClient(access_token=report.access_token)
        try:
            profile = get_or_create_profile(self.platform_client)
            report.profile_id = profile.id
            report.gotrue_id = profile.gotrue_id
            report.free_project_limit = profile.free_project_limit
        except Exception as e:
            report.errors.append(f"profile: {e}")
            return report

        try:
            org = get_or_create_personal_org(self.platform_client, name_hint=org_name)
            report.org_id = org.id
            report.org_slug = org.slug
            report.org_name = org.name
            report.plan_id = org.plan_id
        except Exception as e:
            report.errors.append(f"org: {e}")
            return report

        try:
            token = create_access_token(
                self.platform_client,
                name=pat_name,
                expires_in_days=pat_expires_in_days,
            )
            report.pat = token.token
            report.pat_id = token.id
            report.pat_name = token.name
            report.pat_alias = token.token_alias
            report.pat_expires_at = token.expires_at
        except Exception as e:
            report.errors.append(f"pat: {e}")

        # Close the extension bridge
        await self.extension_bridge.close()
        return report

    # ------------------------------------------------------------------ #
    # Existing-token operations (no signup)
    # ------------------------------------------------------------------ #
    def ensure_profile_org_pat(
        self,
        *,
        pat_name: str = "automation-token",
        pat_expires_in_days: int = 30,
        org_name: str | None = None,
    ) -> OnboardingReport:
        """For an existing token (JWT or PAT), ensure profile + org + PAT exist.

        Useful for "warming up" an account that was created manually but
        doesn't yet have an org or PAT.
        """
        if not self.platform_client:
            raise RuntimeError("platform_client not configured")
        report = OnboardingReport()
        try:
            profile = get_or_create_profile(self.platform_client)
            report.profile_id = profile.id
            report.gotrue_id = profile.gotrue_id
            report.email = profile.primary_email
            report.free_project_limit = profile.free_project_limit
        except Exception as e:
            report.errors.append(f"profile: {e}")
            return report
        try:
            org = get_or_create_personal_org(self.platform_client, name_hint=org_name)
            report.org_id = org.id
            report.org_slug = org.slug
            report.org_name = org.name
            report.plan_id = org.plan_id
        except Exception as e:
            report.errors.append(f"org: {e}")
            return report
        try:
            token = create_access_token(
                self.platform_client,
                name=pat_name,
                expires_in_days=pat_expires_in_days,
            )
            report.pat = token.token
            report.pat_id = token.id
            report.pat_name = token.name
            report.pat_alias = token.token_alias
            report.pat_expires_at = token.expires_at
        except Exception as e:
            report.errors.append(f"pat: {e}")
        return report


__all__ = ["OnboardingAutomation", "OnboardingReport"]
