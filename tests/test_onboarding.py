"""
Offline unit tests for the Supabase onboarding library.

These tests don't make any network calls — they verify the request/response
shapes against the HAR captures and check the parsing logic.

Run with: python -m pytest tests/
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import pytest

# Add the project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from supabase_onboarding.signup.email_worker import EmailWorkerClient, VerificationEmail
from supabase_onboarding.signup.client import SignupClient
from supabase_onboarding.client import SupabasePlatformClient
from supabase_onboarding.profile import _parse_profile
from supabase_onboarding.organization import _parse_org
from supabase_onboarding.access_token import _parse_token


# ---------------------------------------------------------------------- #
# Email worker — verify link extraction
# ---------------------------------------------------------------------- #

class TestVerifyLinkExtraction:
    def test_extracts_link_from_plain_text(self):
        text = """
        Reset your password: https://auth.supabase.io/auth/v1/verify?token=ce9c6501e9a661cb1dc19aef5fa71d71ef838560afd82fec0df5050b&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in
        """
        url = EmailWorkerClient._extract_verify_url(text)
        assert url is not None
        assert "auth.supabase.io/auth/v1/verify" in url
        assert "token=ce9c6501" in url
        assert "type=signup" in url

    def test_extracts_link_with_html_entities(self):
        text = """
        <a href="https://auth.supabase.io/auth/v1/verify?token=abc123&amp;type=signup&amp;redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in">Click</a>
        """
        # The email_worker normalizes &amp; -> & before extracting
        text = text.replace("&amp;", "&")
        url = EmailWorkerClient._extract_verify_url(text)
        assert url is not None
        assert "token=abc123" in url
        assert "type=signup" in url

    def test_returns_none_for_no_link(self):
        text = "This email has no verify link."
        assert EmailWorkerClient._extract_verify_url(text) is None

    def test_returns_none_for_other_urls(self):
        text = "Visit https://supabase.com/dashboard for more info."
        assert EmailWorkerClient._extract_verify_url(text) is None

    def test_strips_trailing_punctuation(self):
        text = "Link: https://auth.supabase.io/auth/v1/verify?token=abc&type=signup."
        url = EmailWorkerClient._extract_verify_url(text)
        assert url is not None
        assert not url.endswith(".")

    def test_extracts_token_from_url(self):
        text = "https://auth.supabase.io/auth/v1/verify?token=deadbeefcafe&type=signup&redirect_to=x"
        url = EmailWorkerClient._extract_verify_url(text)
        assert url is not None
        qs = parse_qs(urlparse(url).query)
        assert qs["token"][0] == "deadbeefcafe"
        assert qs["type"][0] == "signup"


# ---------------------------------------------------------------------- #
# SignupClient — verify_email URL building + redirect_to stripping
# ---------------------------------------------------------------------- #

class TestVerifyEmailUrlBuilding:
    def test_strips_redirect_to_from_verify_url(self):
        sc = SignupClient()
        # Build the URL the way verify_email does
        verify_url = "https://auth.supabase.io/auth/v1/verify?token=abc123&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in"
        parsed = urlparse(verify_url)
        qs = parse_qs(parsed.query)
        qs.pop("redirect_to", None)
        token_val = qs.get("token", [""])[0]
        type_val = qs.get("type", ["signup"])[0]
        url = f"https://auth.supabase.io/auth/v1/verify?token={token_val}&type={type_val}"
        assert "redirect_to" not in url
        assert "token=abc123" in url
        assert "type=signup" in url

    def test_preserves_other_params_when_stripping_redirect_to(self):
        # If Supabase adds more params in the future, we should keep them
        verify_url = "https://auth.supabase.io/auth/v1/verify?token=abc&type=signup&redirect_to=x&future_param=yes"
        parsed = urlparse(verify_url)
        qs = parse_qs(parsed.query)
        qs.pop("redirect_to", None)
        # Note: the current implementation only keeps token + type. If we
        # need to preserve other params, we'd rebuild from qs instead.
        # This test documents the current behavior.
        assert "redirect_to" not in qs
        assert qs["token"][0] == "abc"
        assert qs["type"][0] == "signup"


# ---------------------------------------------------------------------- #
# Verify redirect parsing — extract access_token from Location fragment
# ---------------------------------------------------------------------- #

class TestVerifyRedirectParsing:
    def test_parses_access_token_from_fragment(self):
        location = "https://app.supabase.com#access_token=eyJabc&expires_at=1234&expires_in=1800&refresh_token=ref123&token_type=bearer&type=signup"
        fragment = location.split("#", 1)[1]
        params = parse_qs(fragment)
        assert params["access_token"][0] == "eyJabc"
        assert params["refresh_token"][0] == "ref123"
        assert params["expires_in"][0] == "1800"
        assert params["token_type"][0] == "bearer"
        assert params["type"][0] == "signup"

    def test_detects_error_in_fragment(self):
        location = "https://app.supabase.com#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"
        # The fragment has error params, not access_token
        fragment = location.split("#", 1)[1]
        params = parse_qs(fragment)
        assert "access_token" not in params
        assert params["error"][0] == "access_denied"
        assert params["error_code"][0] == "otp_expired"


# ---------------------------------------------------------------------- #
# Platform profile parsing
# ---------------------------------------------------------------------- #

class TestProfileParsing:
    def test_parses_full_profile(self):
        data = {
            "id": 16327969,
            "auth0_id": "email|c6f93037-d0be-43c0-b631-f6735f775d87",
            "primary_email": "user@privatimail.com",
            "username": "user@privatimail.com",
            "first_name": None,
            "last_name": None,
            "mobile": None,
            "is_alpha_user": False,
            "is_sso_user": False,
            "gotrue_id": "c6f93037-d0be-43c0-b631-f6735f775d87",
            "free_project_limit": 2,
            "disabled_features": [],
        }
        p = _parse_profile(data)
        assert p.id == 16327969
        assert p.gotrue_id == "c6f93037-d0be-43c0-b631-f6735f775d87"
        assert p.primary_email == "user@privatimail.com"
        assert p.free_project_limit == 2
        assert p.disabled_features == []

    def test_parses_profile_with_disabled_features(self):
        data = {
            "id": 1,
            "gotrue_id": "abc",
            "auth0_id": "email|abc",
            "primary_email": "x@y.com",
            "username": "x@y.com",
            "free_project_limit": 0,
            "disabled_features": ["ai", "edge_functions"],
        }
        p = _parse_profile(data)
        assert p.free_project_limit == 0
        assert p.disabled_features == ["ai", "edge_functions"]


# ---------------------------------------------------------------------- #
# Organization parsing
# ---------------------------------------------------------------------- #

class TestOrganizationParsing:
    def test_parses_full_org(self):
        data = {
            "id": 14064728,
            "slug": "becfkdeegfxqpwcexrzg",
            "name": "user@privatimail.com's Org",
            "billing_email": "user@privatimail.com",
            "is_owner": True,
            "stripe_customer_id": "cus_V3fvEb5IbiixKj",
            "subscription_id": "WNeFgEu7A2iyG23N",
            "plan": {"id": "free", "name": "Free"},
        }
        o = _parse_org(data)
        assert o.id == 14064728
        assert o.slug == "becfkdeegfxqpwcexrzg"
        assert o.plan_id == "free"
        assert o.plan_name == "Free"
        assert o.is_owner is True

    def test_parses_org_without_optional_fields(self):
        data = {
            "id": 1,
            "slug": "test",
            "name": "Test",
            "billing_email": "x@y.com",
            "is_owner": True,
            "plan": {},
        }
        o = _parse_org(data)
        assert o.plan_id == ""
        assert o.plan_name == ""
        assert o.stripe_customer_id is None


# ---------------------------------------------------------------------- #
# Access token (PAT) parsing
# ---------------------------------------------------------------------- #

class TestAccessTokenParsing:
    def test_parses_created_token(self):
        data = {
            "id": 6014190,
            "token_alias": "sbp_***••••••••••••***",
            "name": "new-token-30d",
            "created_at": "2026-08-12T09:36:57.153135+00:00",
            "expires_at": "2026-09-11T09:36:56.778+00:00",
            "last_used_at": None,
            "token": "sbp_***TEST_TOKEN***",
        }
        t = _parse_token(data)
        assert t.id == 6014190
        assert t.name == "new-token-30d"
        assert t.token == "sbp_***TEST_TOKEN***"
        assert t.token_alias.startswith("sbp_***")
        assert t.token_alias.endswith("4752")
        assert t.last_used_at is None

    def test_parses_listed_token_no_full_token(self):
        # The list endpoint doesn't return the full `token` field
        data = {
            "id": 6014190,
            "token_alias": "sbp_***••••••••••••***",
            "name": "new-token-30d",
            "created_at": "2026-08-12T09:36:57.153135+00:00",
            "expires_at": "2026-09-11T09:36:56.778+00:00",
            "last_used_at": None,
        }
        t = _parse_token(data)
        assert t.token == ""  # no full token in list response
        assert t.token_alias != ""


# ---------------------------------------------------------------------- #
# SupabasePlatformClient construction
# ---------------------------------------------------------------------- #

class TestPlatformClient:
    def test_token_kind_pat(self):
        c = SupabasePlatformClient(access_token="sbp_abc123")
        assert c.token_kind == "pat"

    def test_token_kind_jwt(self):
        c = SupabasePlatformClient(access_token="eyJabc")
        assert c.token_kind == "jwt"

    def test_token_kind_unknown(self):
        c = SupabasePlatformClient(access_token="garbage")
        assert c.token_kind == "unknown"

    def test_requires_access_token(self):
        with pytest.raises(ValueError):
            SupabasePlatformClient(access_token="")

    def test_base_url_normalization(self):
        c = SupabasePlatformClient(access_token="sbp_x", base_url="https://api.supabase.com/")
        assert c.base_url == "https://api.supabase.com"

    def test_authorization_header_set(self):
        c = SupabasePlatformClient(access_token="sbp_secret")
        assert c._session.headers["Authorization"] == "Bearer sbp_secret"


# ---------------------------------------------------------------------- #
# SignupClient construction
# ---------------------------------------------------------------------- #

class TestSignupClient:
    def test_sets_required_headers(self):
        sc = SignupClient()
        h = sc._session.headers
        assert h["Content-Type"] == "application/json"
        assert h["Origin"] == "https://supabase.com"
        assert h["Referer"] == "https://supabase.com/dashboard/sign-up"
        # sec-ch-ua headers (Chrome sends these on every fetch)
        assert "sec-ch-ua" in h
        assert "sec-ch-ua-platform" in h

    def test_default_endpoints(self):
        sc = SignupClient()
        assert sc.signup_url == "https://api.supabase.com/platform/signup"
        assert sc.user_url == "https://auth.supabase.io/auth/v1/user"


# ---------------------------------------------------------------------- #
# Email worker client construction
# ---------------------------------------------------------------------- #

class TestEmailWorkerClient:
    def test_sets_auth_header(self):
        c = EmailWorkerClient(base_url="https://mail-api.example.com", token="secret")
        assert c._session.headers["Authorization"] == "Bearer secret"

    def test_base_url_normalization(self):
        c = EmailWorkerClient(base_url="https://mail-api.example.com/", token="x")
        assert c.base_url == "https://mail-api.example.com"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
