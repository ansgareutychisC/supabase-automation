#!/usr/bin/env python3
"""
E2E test for the Supabase Onboarding Worker.

Tests the worker's API endpoints directly (no extension needed for most):
1. Health check
2. Extension status (no extension connected)
3. Account import (with a real PAT)
4. Account list
5. Account detail
6. PAT retrieval
7. Export accounts
8. Delete account
9. Dashboard HTML serves correctly
10. Job creation (signup — will fail without extension, but tests the endpoint)

Usage:
    python tests/e2e_worker.py --url https://supabase-onboarding-worker.21cc20ac.workers.dev
"""
import argparse
import json
import sys
import time
import requests

def test(name, func):
    """Run a test function, print result."""
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    try:
        result = func()
        if result is True:
            print(f"✓ PASS")
            return True
        else:
            print(f"✗ FAIL: {result}")
            return False
    except Exception as e:
        print(f"✗ ERROR: {e}")
        return False

def test_health(base_url):
    r = requests.get(f"{base_url}/health", timeout=10)
    data = r.json()
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    assert data.get("ok") is True, f"Expected ok=true, got {data}"
    assert "time" in data, f"Expected time field, got {data}"
    return True

def test_dashboard(base_url):
    r = requests.get(f"{base_url}/", timeout=10)
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    html = r.text
    assert "Supabase Onboarding Worker" in html, "Title not found"
    assert "accountName" in html, "accountName input not found"
    assert "ext-bar" in html, "Extension status bar not found"
    assert "tabs" in html, "Tab navigation not found"
    assert "keydown" in html, "Keyboard handler not found"
    return True

def test_extensions_empty(base_url):
    r = requests.get(f"{base_url}/api/extensions", timeout=10)
    data = r.json()
    assert "extensions" in data, f"Expected extensions field, got {data}"
    assert isinstance(data["extensions"], list), "extensions should be a list"
    return True

def test_import_account(base_url, test_email, test_pat):
    r = requests.post(
        f"{base_url}/api/accounts/import",
        headers={"Content-Type": "application/json"},
        json={
            "email": test_email,
            "password": "TestPassword123!",
            "pat": test_pat,
            "user_id": "test-user-id-12345",
            "org_name": "Test Org",
            "org_slug": "test-org-slug",
        },
        timeout=10,
    )
    data = r.json()
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {data}"
    assert data.get("ok") is True, f"Expected ok=true, got {data}"
    return True

def test_list_accounts(base_url, test_email):
    r = requests.get(f"{base_url}/api/accounts", timeout=10)
    data = r.json()
    assert "accounts" in data, f"Expected accounts field, got {data}"
    emails = [a.get("email") for a in data["accounts"]]
    assert test_email in emails, f"Test email {test_email} not found in accounts: {emails}"
    return True

def test_account_detail(base_url, test_email):
    r = requests.get(f"{base_url}/api/accounts/{test_email}", timeout=10)
    data = r.json()
    assert "account" in data, f"Expected account field, got {data}"
    assert data["account"]["email"] == test_email, f"Email mismatch"
    assert data["account"]["pat"] == "sbp_test_pat_for_e2e", f"PAT mismatch"
    return True

def test_get_pat(base_url, test_email):
    r = requests.get(f"{base_url}/api/accounts/{test_email}/pat", timeout=10)
    data = r.json()
    assert "account" in data, f"Expected account field, got {data}"
    assert data["account"]["pat"] == "sbp_test_pat_for_e2e", f"PAT mismatch"
    return True

def test_export_accounts(base_url, test_email):
    r = requests.post(f"{base_url}/api/accounts/export", timeout=10)
    data = r.json()
    assert "accounts" in data, f"Expected accounts field, got {data}"
    assert "count" in data, f"Expected count field, got {data}"
    assert data["count"] >= 1, f"Expected at least 1 account, got {data['count']}"
    emails = [a.get("email") for a in data["accounts"]]
    assert test_email in emails, f"Test email not in export: {emails}"
    return True

def test_delete_account(base_url, test_email):
    r = requests.delete(f"{base_url}/api/accounts/{test_email}", timeout=10)
    data = r.json()
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {data}"
    assert data.get("ok") is True, f"Expected ok=true, got {data}"
    # Verify it's gone
    r = requests.get(f"{base_url}/api/accounts", timeout=10)
    emails = [a.get("email") for a in r.json().get("accounts", [])]
    assert test_email not in emails, f"Account {test_email} still exists after delete"
    return True

def test_run_pipeline_no_extension(base_url):
    """Test that /api/run returns 202 (job accepted) even without extension.
    The job will fail later because no extension is connected, but the endpoint
    should still accept the request."""
    r = requests.post(
        f"{base_url}/api/run",
        headers={"Content-Type": "application/json"},
        json={"email": "e2e-test-no-ext@privatimail.com", "password": "Test123!Secure"},
        timeout=10,
    )
    data = r.json()
    assert r.status_code == 202, f"Expected 202, got {r.status_code}: {data}"
    assert "jobId" in data, f"Expected jobId, got {data}"
    assert "email" in data, f"Expected email, got {data}"
    assert "password" in data, f"Expected password, got {data}"
    return True

def test_jobs_list(base_url):
    r = requests.get(f"{base_url}/api/jobs", timeout=10)
    data = r.json()
    assert "jobs" in data, f"Expected jobs field, got {data}"
    assert isinstance(data["jobs"], list), "jobs should be a list"
    return True

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://supabase-onboarding-worker.21cc20ac.workers.dev",
                        help="Worker URL")
    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    print(f"E2E Test for Supabase Onboarding Worker")
    print(f"URL: {base_url}")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    test_email = f"e2e-test-{int(time.time())}@privatimail.com"
    test_pat = "sbp_test_pat_for_e2e"

    tests = [
        ("Health check", lambda: test_health(base_url)),
        ("Dashboard HTML", lambda: test_dashboard(base_url)),
        ("Extensions (empty)", lambda: test_extensions_empty(base_url)),
        ("Import account", lambda: test_import_account(base_url, test_email, test_pat)),
        ("List accounts", lambda: test_list_accounts(base_url, test_email)),
        ("Account detail", lambda: test_account_detail(base_url, test_email)),
        ("Get PAT", lambda: test_get_pat(base_url, test_email)),
        ("Export accounts", lambda: test_export_accounts(base_url, test_email)),
        ("Run pipeline (no extension)", lambda: test_run_pipeline_no_extension(base_url)),
        ("Jobs list", lambda: test_jobs_list(base_url)),
        ("Delete account", lambda: test_delete_account(base_url, test_email)),
    ]

    passed = 0
    failed = 0
    for name, func in tests:
        if test(name, func):
            passed += 1
        else:
            failed += 1

    print(f"\n{'='*60}")
    print(f"RESULTS: {passed} passed, {failed} failed, {len(tests)} total")
    print(f"{'='*60}")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
