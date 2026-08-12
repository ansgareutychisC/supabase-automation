#!/usr/bin/env python3
"""
E2E signup flow — streamlined version.

Flow:
1. Open fresh signup page (via extension)
2. Fill email + password using extension form.fill
3. Click submit (you solve hCaptcha in browser)
4. Poll email worker (plain HTTP) for verify link
5. Follow verify link (strip redirect_to) → get JWT
6. Create profile, org, PAT (plain HTTP with JWT)
7. Verify PAT works

Usage:
    python scripts/e2e_signup.py --email supa-e2e-4@privatimail.com --password 'SupabaseE2E2026!Secure'
"""
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from supabase_onboarding.extension_bridge import ExtensionBridge
from supabase_onboarding.signup.client import SignupClient
from supabase_onboarding.client import SupabasePlatformClient
from supabase_onboarding.profile import get_or_create_profile
from supabase_onboarding.organization import get_or_create_personal_org
from supabase_onboarding.access_token import create_access_token

EMAIL_WORKER_URL = "https://mail-api.privatimail.com"
EMAIL_WORKER_TOKEN = "<EMAIL_WORKER_TOKEN>"


def poll_email_worker(email: str, timeout: float = 300.0) -> str | None:
    """Poll email worker for verify link. Returns the URL or None."""
    deadline = time.time() + timeout
    start = time.time()
    while time.time() < deadline:
        try:
            r = requests.get(
                f"{EMAIL_WORKER_URL}/emails",
                params={"address": email, "limit": 10, "include_body": "true"},
                headers={"Authorization": f"Bearer {EMAIL_WORKER_TOKEN}"},
                timeout=10,
            )
            if r.ok:
                for em in r.json().get("results", []):
                    body = (em.get("text_body", "") or "") + (em.get("html_body", "") or "")
                    body = body.replace("&amp;", "&")
                    m = re.search(r'https://auth\.supabase\.io/auth/v1/verify\?[^\s"\'<>]+', body)
                    if m:
                        url = m.group(0).rstrip('.,);]')
                        print(f"  ✓ Verify email found after {time.time()-start:.0f}s")
                        return url
        except Exception as e:
            print(f"  poll error: {e}")
        time.sleep(3)
    return None


async def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--captcha-timeout", type=float, default=300.0)
    args = p.parse_args()

    print(f"=== Supabase E2E Signup ===")
    print(f"Email: {args.email}")
    print(f"Password: {'*' * len(args.password)} ({len(args.password)} chars)")
    print()

    # Step 1: Connect to extension
    print("[1/7] Connecting to extension...")
    bridge = ExtensionBridge(host="127.0.0.1", port=8787, timeout=15)
    await bridge.connect()
    if not await bridge.is_extension_connected():
        print("  ✗ Extension not connected. Click Connect in the popup.")
        return 1
    print("  ✓ Extension connected")

    # Step 2: Open fresh signup page
    print("\n[2/7] Opening signup page...")
    r = await bridge.tabs_open("https://supabase.com/dashboard/sign-up", active=True)
    tab_id = r.get("tabId")
    print(f"  ✓ Opened in tab {tab_id}")
    await asyncio.sleep(4)

    # Step 3: Fill form
    print("\n[3/7] Filling form...")
    # Clear any existing values first
    await bridge.form_eval(tab_id, '''
      const e = document.querySelector('#email');
      const p = document.querySelector('#password');
      if (e) { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(e, ''); e.dispatchEvent(new Event('input', {bubbles:true})); }
      if (p) { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(p, ''); p.dispatchEvent(new Event('input', {bubbles:true})); }
    ''')
    await bridge.form_fill(tab_id, "#email", args.email)
    await bridge.form_fill(tab_id, "#password", args.password)
    # Verify
    r = await bridge.form_eval(tab_id, 'return {email: document.querySelector("#email").value, pwLen: document.querySelector("#password").value.length, btnDisabled: document.querySelector("button[type=submit]").disabled};')
    info = r.get("result")
    if isinstance(info, str): info = json.loads(info)
    print(f"  Email: {info.get('email')}")
    print(f"  Password length: {info.get('pwLen')}")
    print(f"  Button disabled: {info.get('btnDisabled')}")

    # Step 4: Click submit + tell user to solve captcha
    print("\n[4/7] Clicking Sign Up — SOLVE THE hCaptcha IN YOUR BROWSER")
    await bridge.form_click(tab_id, 'button[type="submit"]')
    print("  ✓ Clicked. Waiting for you to solve hCaptcha...")

    # Step 5: Poll email worker in parallel
    print("\n[5/7] Polling email worker for verify link...")
    verify_url = poll_email_worker(args.email, timeout=args.captcha_timeout)
    if not verify_url:
        print("  ✗ No verify email received within timeout")
        await bridge.close()
        return 1
    print(f"  ✓ Verify URL: {verify_url[:80]}...")

    # Step 6: Follow verify link (plain HTTP)
    print("\n[6/7] Following verify link (stripping redirect_to)...")
    sc = SignupClient()
    tokens = sc.verify_email(verify_url=verify_url)
    print(f"  ✓ access_token: {tokens['access_token'][:40]}...")
    print(f"  ✓ expires_in: {tokens['expires_in']}s")
    user = sc.get_user(tokens["access_token"])
    print(f"  ✓ user_id: {user.get('id')}")

    # Step 7: Create profile, org, PAT
    print("\n[7/7] Creating profile + org + PAT...")
    client = SupabasePlatformClient(access_token=tokens["access_token"])
    profile = get_or_create_profile(client)
    print(f"  ✓ Profile: id={profile.id} email={profile.primary_email}")
    org = get_or_create_personal_org(client)
    print(f"  ✓ Org: id={org.id} slug={org.slug} name={org.name!r}")
    pat = create_access_token(client, name="e2e-test-pat", expires_in_days=30)
    print(f"  ✓ PAT: {pat.token}")

    # Verify PAT works
    print("\n=== Verifying PAT works ===")
    pat_client = SupabasePlatformClient(access_token=pat.token)
    valid = pat_client.is_token_valid()
    print(f"  PAT valid: {valid}")

    # Final report
    print("\n" + "=" * 60)
    print("  🎉 E2E SIGNUP COMPLETE!")
    print("=" * 60)
    print(f"  Email:       {user.get('email')}")
    print(f"  User ID:     {user.get('id')}")
    print(f"  Profile ID:  {profile.id}")
    print(f"  Org:         {org.name} (slug={org.slug})")
    print(f"  PAT:         {pat.token}")
    print(f"  PAT expires: {pat.expires_at}")
    print("=" * 60)
    print(f"\n  export SUPABASE_ACCESS_TOKEN={pat.token}")

    await bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
