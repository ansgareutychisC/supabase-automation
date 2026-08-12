#!/usr/bin/env python3
"""
Supabase Onboarding Automation CLI.

Commands:
    # Status / inspection
    verify                              # Read-only: check token validity, print profile/orgs
    bridge-status                       # Check the bridge daemon + extension connection

    # Individual operations (existing account - JWT or PAT)
    create-profile                      # POST /platform/profile
    create-org --name "My Org"          # POST /platform/organizations
    create-pat --name my-token          # POST /platform/profile/access-tokens
    list-pats                           # GET /platform/profile/access-tokens
    list-orgs                           # GET /platform/organizations

    # Signup flows
    signup --email X --password Y --captcha-token Z   # Plain HTTP signup (manual captcha)
    verify-email --email X                              # Poll email worker + follow verify link
    run-full --email X --password Y --captcha-token Z  # Full flow: signup → verify → profile → org → PAT

    # Extension-based flows (requires bridge daemon + Chrome extension)
    signup-ext --email X --password Y                   # Extension drives signup form
    run-full-ext --email X --password Y                 # Extension signup → verify → profile → org → PAT

Exit codes:
    0 — success
    1 — one or more operations failed
    2 — auth failure (missing/invalid token)
    3 — other API error
    4 — missing required env vars or args
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

# Add the project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from supabase_onboarding import (
    SupabasePlatformClient,
    SignupClient,
    EmailWorkerClient,
    OnboardingAutomation,
    SupabaseError,
    SupabaseAuthError,
    SupabaseAPIError,
    ExtensionNotConnectedError,
)
from supabase_onboarding.profile import get_profile, get_or_create_profile
from supabase_onboarding.organization import list_organizations, get_or_create_personal_org
from supabase_onboarding.access_token import (
    create_access_token, list_access_tokens, delete_access_token,
)

log = logging.getLogger("supabase_automate")


def load_env() -> dict:
    """Load config from environment variables (.env not auto-loaded)."""
    return {
        "email_worker_base_url": os.environ.get("EMAIL_WORKER_BASE_URL", ""),
        "email_worker_token": os.environ.get("EMAIL_WORKER_TOKEN", ""),
        "bridge_host": os.environ.get("BRIDGE_HOST", "127.0.0.1"),
        "bridge_port": int(os.environ.get("BRIDGE_PORT", "8787")),
        "bridge_auth_token": os.environ.get("BRIDGE_AUTH_TOKEN", ""),
        "access_token": os.environ.get("SUPABASE_ACCESS_TOKEN", ""),
        "signup_email_domain": os.environ.get("SUPABASE_SIGNUP_EMAIL_DOMAIN", "privatimail.com"),
        "default_password": os.environ.get("SUPABASE_SIGNUP_DEFAULT_PASSWORD", ""),
    }


def get_email_worker(env: dict) -> EmailWorkerClient | None:
    if not env["email_worker_base_url"] or not env["email_worker_token"]:
        return None
    return EmailWorkerClient(
        base_url=env["email_worker_base_url"],
        token=env["email_worker_token"],
    )


def get_platform_client(env: dict) -> SupabasePlatformClient:
    if not env["access_token"]:
        print("ERROR: SUPABASE_ACCESS_TOKEN is not set. Provide a JWT or PAT (sbp_...).",
              file=sys.stderr)
        sys.exit(2)
    return SupabasePlatformClient(access_token=env["access_token"])


def print_json(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


# ---------------------------------------------------------------------- #
# Commands
# ---------------------------------------------------------------------- #

def cmd_verify(args, env: dict) -> int:
    """Read-only: check token validity, print profile + orgs."""
    client = get_platform_client(env)
    print(f"Token kind: {client.token_kind}")
    print(f"Token (first 40): {client.access_token[:40]}...")

    valid = client.is_token_valid()
    print(f"Token valid: {valid}")
    if not valid:
        print("Token is invalid or expired.", file=sys.stderr)
        return 2

    profile = get_profile(client)
    if profile:
        print(f"\nProfile:")
        print(f"  id:                {profile.id}")
        print(f"  gotrue_id:         {profile.gotrue_id}")
        print(f"  primary_email:     {profile.primary_email}")
        print(f"  free_project_limit: {profile.free_project_limit}")
    else:
        print("\nProfile: not yet created (run `create-profile`)")

    orgs = list_organizations(client)
    print(f"\nOrganizations ({len(orgs)}):")
    for o in orgs:
        print(f"  - id={o.id} slug={o.slug} name={o.name!r} plan={o.plan_id}")
    return 0


def cmd_create_profile(args, env: dict) -> int:
    client = get_platform_client(env)
    profile = get_or_create_profile(client)
    print(f"Profile: id={profile.id} email={profile.primary_email} "
          f"free_project_limit={profile.free_project_limit}")
    return 0


def cmd_create_org(args, env: dict) -> int:
    client = get_platform_client(env)
    org = get_or_create_personal_org(client, name_hint=args.name)
    print(f"Organization: id={org.id} slug={org.slug} name={org.name!r} plan={org.plan_id}")
    return 0


def cmd_list_orgs(args, env: dict) -> int:
    client = get_platform_client(env)
    orgs = list_organizations(client)
    print_json([{"id": o.id, "slug": o.slug, "name": o.name, "plan": o.plan_id} for o in orgs])
    return 0


def cmd_create_pat(args, env: dict) -> int:
    client = get_platform_client(env)
    token = create_access_token(
        client, name=args.name, expires_in_days=args.expires_in_days,
    )
    print(f"PAT created:")
    print(f"  id:         {token.id}")
    print(f"  name:       {token.name}")
    print(f"  alias:      {token.token_alias}")
    print(f"  expires_at: {token.expires_at}")
    print(f"  token:      {token.token}")
    print(f"\nSave this token - it won't be shown again.")
    print(f"  export SUPABASE_ACCESS_TOKEN={token.token}")
    return 0


def cmd_list_pats(args, env: dict) -> int:
    client = get_platform_client(env)
    tokens = list_access_tokens(client)
    print_json([{
        "id": t.id, "name": t.name, "alias": t.token_alias,
        "expires_at": t.expires_at, "last_used_at": t.last_used_at,
    } for t in tokens])
    return 0


def cmd_delete_pat(args, env: dict) -> int:
    client = get_platform_client(env)
    delete_access_token(client, args.token_id)
    print(f"Deleted PAT id={args.token_id}")
    return 0


def cmd_signup(args, env: dict) -> int:
    """Plain HTTP signup (manual captcha token)."""
    if not args.captcha_token:
        print("ERROR: --captcha-token is required for signup. "
              "Get one from hCaptcha's JS SDK in a real browser, or use "
              "`signup-ext` for the extension-based flow.", file=sys.stderr)
        return 4
    ew = get_email_worker(env)
    if not ew:
        print("ERROR: EMAIL_WORKER_BASE_URL and EMAIL_WORKER_TOKEN must be set.",
              file=sys.stderr)
        return 4
    sc = SignupClient()
    try:
        result = sc.signup_and_verify(
            email=args.email,
            password=args.password,
            challenge_token=args.captcha_token,
            email_worker=ew,
            email_wait_timeout=args.email_timeout,
        )
    except SupabaseError as e:
        print(f"Signup failed: {e}", file=sys.stderr)
        return 3
    print(f"Signup OK!")
    print(f"  user_id:         {result.user_id}")
    print(f"  email:           {result.email}")
    print(f"  access_token:    {result.access_token}")
    print(f"  refresh_token:   {result.refresh_token}")
    print(f"  expires_in:      {result.expires_in}s")
    print(f"\nExport the access token for follow-up operations:")
    print(f"  export SUPABASE_ACCESS_TOKEN={result.access_token}")
    return 0


def cmd_verify_email(args, env: dict) -> int:
    """Poll email worker for verify link + follow it."""
    ew = get_email_worker(env)
    if not ew:
        print("ERROR: EMAIL_WORKER_BASE_URL and EMAIL_WORKER_TOKEN must be set.",
              file=sys.stderr)
        return 4
    sc = SignupClient()
    try:
        result = sc.verify_only(args.email, ew, email_wait_timeout=args.email_timeout)
    except SupabaseError as e:
        print(f"Verify failed: {e}", file=sys.stderr)
        return 3
    print(f"Verify OK!")
    print(f"  user_id:         {result.user_id}")
    print(f"  email:           {result.email}")
    print(f"  access_token:    {result.access_token}")
    print(f"  expires_in:      {result.expires_in}s")
    return 0


def cmd_run_full(args, env: dict) -> int:
    """Full flow: signup → verify → profile → org → PAT (plain HTTP)."""
    if not args.captcha_token:
        print("ERROR: --captcha-token is required for run-full.", file=sys.stderr)
        return 4
    ew = get_email_worker(env)
    if not ew:
        print("ERROR: EMAIL_WORKER_BASE_URL and EMAIL_WORKER_TOKEN must be set.",
              file=sys.stderr)
        return 4
    auto = OnboardingAutomation.for_signup(email_worker=ew)
    try:
        report = auto.run_full(
            email=args.email,
            password=args.password,
            challenge_token=args.captcha_token,
            org_name=args.org_name,
            pat_name=args.pat_name,
            pat_expires_in_days=args.pat_expires_in_days,
            email_wait_timeout=args.email_timeout,
        )
    except SupabaseError as e:
        print(f"Onboarding failed: {e}", file=sys.stderr)
        return 3
    print(report.summary())
    if not report.is_success:
        return 1
    print(f"\n=== Next steps ===")
    print(f"  export SUPABASE_ACCESS_TOKEN={report.pat}")
    print(f"  supabase login --token {report.pat}")
    return 0


def cmd_signup_ext(args, env: dict) -> int:
    """Extension-based signup (manual captcha solve in browser)."""
    ew = get_email_worker(env)
    if not ew:
        print("ERROR: EMAIL_WORKER_BASE_URL and EMAIL_WORKER_TOKEN must be set.",
              file=sys.stderr)
        return 4
    auto = OnboardingAutomation.for_extension(
        email_worker=ew,
        bridge_host=env["bridge_host"],
        bridge_port=env["bridge_port"],
        bridge_auth_token=env["bridge_auth_token"],
    )

    async def run():
        await auto.extension_bridge.connect()
        await auto.extension_bridge.wait_for_extension(timeout=args.captcha_timeout + 60)
        return await auto.extension_bridge.signup_with_extension(
            args.email, args.password, captcha_wait_timeout=args.captcha_timeout,
        )

    try:
        result = asyncio.run(run())
    except Exception as e:
        print(f"Extension signup failed: {e}", file=sys.stderr)
        return 3
    if not result.get("ok"):
        print(f"Signup failed: {result.get('error')}", file=sys.stderr)
        return 1
    print(f"Signup OK! (tab_id={result.get('tab_id')}, status={result.get('signup_status')})")
    print(f"Now run `verify-email --email {args.email}` to complete verification.")
    return 0


def cmd_run_full_ext(args, env: dict) -> int:
    """Extension-based full flow: signup → verify → profile → org → PAT."""
    ew = get_email_worker(env)
    if not ew:
        print("ERROR: EMAIL_WORKER_BASE_URL and EMAIL_WORKER_TOKEN must be set.",
              file=sys.stderr)
        return 4
    auto = OnboardingAutomation.for_extension(
        email_worker=ew,
        bridge_host=env["bridge_host"],
        bridge_port=env["bridge_port"],
        bridge_auth_token=env["bridge_auth_token"],
    )

    async def run():
        return await auto.run_full_ext(
            email=args.email,
            password=args.password,
            org_name=args.org_name,
            pat_name=args.pat_name,
            pat_expires_in_days=args.pat_expires_in_days,
            email_wait_timeout=args.email_timeout,
            captcha_wait_timeout=args.captcha_timeout,
        )

    try:
        report = asyncio.run(run())
    except SupabaseError as e:
        print(f"Onboarding failed: {e}", file=sys.stderr)
        return 3
    except Exception as e:
        print(f"Onboarding failed (non-API): {e}", file=sys.stderr)
        return 3
    print(report.summary())
    if not report.is_success:
        return 1
    print(f"\n=== Next steps ===")
    print(f"  export SUPABASE_ACCESS_TOKEN={report.pat}")
    print(f"  supabase login --token {report.pat}")
    return 0


def cmd_bridge_status(args, env: dict) -> int:
    """Check the bridge daemon + extension connection."""
    import requests
    url = f"http://{env['bridge_host']}:{env['bridge_port']}/health"
    try:
        r = requests.get(url, timeout=5)
        if r.status_code != 200:
            print(f"Bridge daemon returned {r.status_code}", file=sys.stderr)
            return 1
        data = r.json()
        print(f"Bridge daemon: {url}")
        print(f"  ok:                   {data.get('ok')}")
        print(f"  uptime:               {data.get('uptime_seconds', 0):.0f}s")
        print(f"  extension_connected:  {data.get('extension_connected')}")
        print(f"  extension_info:       {data.get('extension_info')}")
        print(f"  commands_received:    {data.get('commands_received')}")
        print(f"  commands_completed:   {data.get('commands_completed')}")
        print(f"  commands_failed:      {data.get('commands_failed')}")
        return 0 if data.get("extension_connected") else 1
    except requests.ConnectionError:
        print(f"Bridge daemon is not running at {url}", file=sys.stderr)
        print(f"Start it with: python scripts/run_bridge.py --port {env['bridge_port']}",
              file=sys.stderr)
        return 1


# ---------------------------------------------------------------------- #
# Argparse
# ---------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="automate.py",
        description="Supabase Onboarding Automation CLI",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # verify
    sp = sub.add_parser("verify", help="Read-only: check token validity, print profile/orgs")
    sp.set_defaults(func=cmd_verify)

    # create-profile
    sp = sub.add_parser("create-profile", help="Create the platform profile")
    sp.set_defaults(func=cmd_create_profile)

    # create-org
    sp = sub.add_parser("create-org", help="Create a personal organization")
    sp.add_argument("--name", default=None, help="Org name (default: <email>'s Org)")
    sp.set_defaults(func=cmd_create_org)

    # list-orgs
    sp = sub.add_parser("list-orgs", help="List organizations")
    sp.set_defaults(func=cmd_list_orgs)

    # create-pat
    sp = sub.add_parser("create-pat", help="Create a Personal Access Token (sbp_...)")
    sp.add_argument("--name", default="automation-token")
    sp.add_argument("--expires-in-days", type=int, default=30)
    sp.set_defaults(func=cmd_create_pat)

    # list-pats
    sp = sub.add_parser("list-pats", help="List PATs (token value not returned)")
    sp.set_defaults(func=cmd_list_pats)

    # delete-pat
    sp = sub.add_parser("delete-pat", help="Delete a PAT by id")
    sp.add_argument("token_id", type=int)
    sp.set_defaults(func=cmd_delete_pat)

    # signup (plain HTTP)
    sp = sub.add_parser("signup", help="Plain HTTP signup (manual captcha token)")
    sp.add_argument("--email", required=True)
    sp.add_argument("--password", required=True)
    sp.add_argument("--captcha-token", required=True,
                    help="hCaptcha P1_... token from a real browser")
    sp.add_argument("--email-timeout", type=float, default=180.0)
    sp.set_defaults(func=cmd_signup)

    # verify-email
    sp = sub.add_parser("verify-email", help="Poll email worker + follow verify link")
    sp.add_argument("--email", required=True)
    sp.add_argument("--email-timeout", type=float, default=180.0)
    sp.set_defaults(func=cmd_verify_email)

    # run-full (plain HTTP)
    sp = sub.add_parser("run-full", help="Full flow: signup → verify → profile → org → PAT")
    sp.add_argument("--email", required=True)
    sp.add_argument("--password", required=True)
    sp.add_argument("--captcha-token", required=True)
    sp.add_argument("--org-name", default=None)
    sp.add_argument("--pat-name", default="automation-token")
    sp.add_argument("--pat-expires-in-days", type=int, default=30)
    sp.add_argument("--email-timeout", type=float, default=180.0)
    sp.set_defaults(func=cmd_run_full)

    # signup-ext
    sp = sub.add_parser("signup-ext", help="Extension-based signup (manual captcha solve)")
    sp.add_argument("--email", required=True)
    sp.add_argument("--password", required=True)
    sp.add_argument("--captcha-timeout", type=float, default=300.0)
    sp.set_defaults(func=cmd_signup_ext)

    # run-full-ext
    sp = sub.add_parser("run-full-ext", help="Extension-based full flow")
    sp.add_argument("--email", required=True)
    sp.add_argument("--password", required=True)
    sp.add_argument("--org-name", default=None)
    sp.add_argument("--pat-name", default="automation-token")
    sp.add_argument("--pat-expires-in-days", type=int, default=30)
    sp.add_argument("--email-timeout", type=float, default=180.0)
    sp.add_argument("--captcha-timeout", type=float, default=300.0)
    sp.set_defaults(func=cmd_run_full_ext)

    # bridge-status
    sp = sub.add_parser("bridge-status", help="Check the bridge daemon + extension")
    sp.set_defaults(func=cmd_bridge_status)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    env = load_env()
    try:
        return args.func(args, env)
    except SupabaseAuthError as e:
        print(f"Auth error: {e}", file=sys.stderr)
        return 2
    except SupabaseAPIError as e:
        print(f"API error: {e}", file=sys.stderr)
        return 3
    except SupabaseError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
