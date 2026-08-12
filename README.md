# Supabase Onboarding Automation

Automate the full Supabase account lifecycle — from sign-up through org
creation and PAT generation — via a mix of plain HTTP calls and (only
for the hCaptcha-protected signup step) a Chrome extension bridge.

This project mirrors the architecture of
[notion-onboarding-automation](https://github.com/ansgareutychisC/notion-onboarding-automation)
and adapts it for Supabase. The Notion project's reverse-engineering
approach (documented vs. genuinely-undocumented endpoints, HAR-backed
mock testing, email-link signup via Cloudflare Email Worker) is preserved.

After examining the Supabase dashboard API (`api.supabase.com/platform/*`)
via three HAR captures, here's the breakdown of which operations are
documented vs. genuinely undocumented:

| # | Operation | Endpoint | Documentation status |
|---|-----------|----------|----------------------|
| 0 | **Sign up new account** | `POST api.supabase.com/platform/signup` | ❌ **Genuinely undocumented** — requires hCaptcha token. Not in the Management API docs. |
| 1 | **Verify email** | `GET auth.supabase.io/auth/v1/verify?token=X&type=signup` | ⚠️ **Documented but buggy** — the `redirect_to` param causes a 400 "Verify requires a verification type". Workaround: strip `redirect_to`. |
| 2 | **Get user** | `GET auth.supabase.io/auth/v1/user` | ✅ Standard GoTrue endpoint. |
| 3 | **Create platform profile** | `POST api.supabase.com/platform/profile` | ❌ **Genuinely undocumented** — links the GoTrue user to a platform account. |
| 4 | **Create organization** | `POST api.supabase.com/platform/organizations` | ❌ **Genuinely undocumented** — creates the initial PERSONAL org. |
| 5 | **Generate PAT** | `POST api.supabase.com/platform/profile/access-tokens` | ❌ **Genuinely undocumented** — returns the `sbp_...` token for the Management API. |

So of the 6 operations:
- **5 are genuinely undocumented** (only available via the dashboard API)
- **1 is documented but has a redirect_to bug** (email verify)

For the signup flow, the verification email is fetched via a separate
[Cloudflare Email Worker](https://github.com/ansgareutychisO/cloudflare-email-worker)
instance that receives mail for `*@privatimail.com` and exposes an HTTP
API for querying the inbox. **Same instance as the Notion/Todoist
projects** — the user said to reuse it.

---

## Architecture

```
┌──────────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  automate.py (CLI)   │      │  Bridge daemon      │      │  Chrome extension│
│  - signup            │ HTTP │  (aiohttp + WS)      │ WS   │  (background.js) │
│  - verify-email      │─────▶│  127.0.0.1:8787     │◀────▶│  - fetch()       │
│  - create-org        │      │                     │      │  - form.fill     │
│  - create-pat        │      │  Double-forked to   │      │  - xhr.intercept │
│  - run-full          │      │  survive bash       │      │  - getCaptchaToken│
│  - run-full-ext      │      │  toolcall kills     │      │                  │
└──────────┬───────────┘      └─────────────────────┘      └──────────────────┘
           │                                                        │
           │ HTTP                                                   │ drives real browser
           ▼                                                        ▼
┌──────────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  api.supabase.com    │      │  Email Worker       │      │  supabase.com    │
│  /platform/signup    │      │  (Cloudflare Worker)│      │  /dashboard/     │
│  /platform/profile   │      │  mail-api.privati-  │      │  sign-up         │
│  /platform/orgs      │      │  mail.com           │      │  (hCaptcha here) │
│  /platform/pat       │      │                     │      │                  │
└──────────────────────┘      └─────────────────────┘      └──────────────────┘
           │
           │ Bearer <JWT or PAT>
           ▼
┌──────────────────────┐
│  auth.supabase.io    │
│  /auth/v1/verify     │  ← returns 303 with access_token in Location fragment
│  /auth/v1/user       │
└──────────────────────┘
```

**Key insight**: Only the signup step (hCaptcha) needs the browser
extension. After signup, the entire flow (email verify → profile → org →
PAT) works with plain `requests` — NO WAF, NO browser needed.

The verify step is especially elegant: the `GET /auth/v1/verify` endpoint
returns a 303 redirect with the `access_token` (JWT) in the URL fragment.
We parse it from the `Location` header — no browser interaction needed.

---

## Quick start

```bash
# 1. Install
pip install -r requirements.txt

# 2. Configure environment
cp .env.example .env
# Edit .env: set EMAIL_WORKER_BASE_URL, EMAIL_WORKER_TOKEN, SUPABASE_SIGNUP_DEFAULT_PASSWORD

# ────────────────────────────────────────────────────────────────────
# Option A: Full signup → verify → profile → org → PAT (manual captcha)
# ────────────────────────────────────────────────────────────────────
# Get an hCaptcha token manually:
#   1. Open https://supabase.com/dashboard/sign-up in Chrome
#   2. Open devtools → Network
#   3. Fill email + password, solve the captcha, click Continue
#   4. Find the POST /platform/signup request, copy the hcaptchaToken from the request body
#   5. Use it within 2 minutes (hCaptcha tokens expire)

export EMAIL_WORKER_BASE_URL=https://mail-api.privatimail.com
export EMAIL_WORKER_TOKEN=<your-worker-token>

python automate.py run-full \
  --email user@privatimail.com \
  --password 'StrongPassword123!' \
  --captcha-token 'P1_eyJ...'

# ────────────────────────────────────────────────────────────────────
# Option B: Full signup → verify → ... (browser extension, manual captcha solve)
# ────────────────────────────────────────────────────────────────────
# 1. Start the bridge daemon (double-forked, survives bash toolcalls):
python scripts/run_bridge.py --port 8787

# 2. Check the daemon is up:
python automate.py bridge-status

# 3. Load the Chrome extension:
#    - Go to chrome://extensions/
#    - Enable Developer mode
#    - Click "Load unpacked"
#    - Select the extension/ directory
#    - Click the extension icon, set Server URL to ws://localhost:8787/ws
#    - Click Connect

# 4. Run the full flow (extension opens the signup page, you solve the captcha):
python automate.py run-full-ext \
  --email user@privatimail.com \
  --password 'StrongPassword123!'

# ────────────────────────────────────────────────────────────────────
# Option C: Operate on an EXISTING account (you already have a JWT or PAT)
# ────────────────────────────────────────────────────────────────────
export SUPABASE_ACCESS_TOKEN=sbp_...    # or the JWT from verify

python automate.py verify               # read-only inspection
python automate.py create-org --name "My Org"
python automate.py create-pat --name my-pat --expires-in-days 365
python automate.py list-pats
python automate.py list-orgs
```

---

## What's automated

| # | Operation | Endpoint | Key field |
|---|-----------|----------|-----------|
| 0 | Sign up new account | `POST /platform/signup` | `{"email": "...", "password": "...", "hcaptchaToken": "P1_..."}` — hCaptcha required |
| 1 | Verify email | `GET /auth/v1/verify?token=X&type=signup` | 303 redirect with `#access_token=<JWT>&refresh_token=...&expires_in=1800` — **strip `redirect_to` param** (bug workaround) |
| 2 | Get user | `GET /auth/v1/user` | `Authorization: Bearer <JWT>` — confirms the session works |
| 3 | Create platform profile | `POST /platform/profile` | Empty body `{}` — server derives everything from the JWT. Returns `{id, gotrue_id, primary_email, free_project_limit}` |
| 4 | Create organization | `POST /platform/organizations` | `{"name": "...", "kind": "PERSONAL", "tier": "tier_free"}` |
| 5 | Generate PAT | `POST /platform/profile/access-tokens` | `{"name": "...", "expires_at": "2026-09-11T09:36:56.778Z"}` — returns `{token: "sbp_..."}` |

After step 5, the `sbp_...` PAT replaces the short-lived JWT (30 min) and
can be used for all Management API operations (create projects, manage
databases, etc.) via `Authorization: Bearer sbp_...`.

---

## The `redirect_to` bug

The verification email contains a link like:

```
https://auth.supabase.io/auth/v1/verify?token=ce9c6501...&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in
```

If you open this URL as-is, the dashboard shows:

```json
{"code":400,"error_code":"validation_failed","msg":"Verify requires a verification type"}
```

If you **remove the `redirect_to` param**, the verify endpoint redirects
to `https://app.supabase.com#access_token=<JWT>&...` which works
correctly.

This is a Supabase-side bug — the `redirect_to` param somehow causes the
dashboard's verify-completion flow to lose the `type` param. The
workaround in this library is to always strip `redirect_to` before
calling the verify endpoint. See
`supabase_onboarding/signup/client.py:verify_email()` for the
implementation.

---

## Repo layout

```
supabase-automation/
├── automate.py                              # CLI entry point
├── requirements.txt
├── .env.example                             # template for EMAIL_WORKER_* + SUPABASE_ACCESS_TOKEN
├── .gitignore
├── pytest.ini
├── supabase_onboarding/
│   ├── __init__.py                          # public API exports
│   ├── client.py                            # SupabasePlatformClient — Bearer-auth HTTP client
│   ├── exceptions.py                        # SupabaseAPIError + subclasses
│   ├── profile.py                           # create_profile, get_profile
│   ├── organization.py                      # create_organization, list_organizations
│   ├── access_token.py                      # create_access_token (PAT), list, delete
│   ├── onboarding.py                        # high-level OnboardingAutomation facade
│   ├── extension_bridge.py                  # ExtensionBridge — HTTP client for the daemon
│   └── signup/
│       ├── __init__.py
│       ├── client.py                        # SignupClient — signup + verify_email + get_user
│       └── email_worker.py                  # EmailWorkerClient — polls Cloudflare Email Worker for verify links
├── extension/                               # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js                        # service worker — command executor
│   ├── popup.html / popup.js                # connection UI + diagnostics
│   ├── sandbox.html / sandbox.js            # page-context fetch (for zstd responses)
│   └── icons/
├── scripts/
│   ├── run_bridge.py                        # double-fork launcher (survives bash toolcalls)
│   └── run_bridge_aiohttp.py                # the actual aiohttp bridge server
├── docs/
│   └── reverse-engineering-notes.md         # field-level API reference from the HARs
├── tests/
│   └── test_onboarding.py                   # offline pytest cases
├── supabase.signup-pt1.har.zip              # HAR capture: signup flow
├── supabase.signup-pt1-tk2.har.zip          # HAR capture: signup retry attempts
├── supabase.signup-pt2.har.zip              # HAR capture: post-verify flow (profile, org, PAT)
└── supabase.signup-email.txt                # sample verification email
```

---

## Using the library programmatically

```python
from supabase_onboarding import (
    OnboardingAutomation, EmailWorkerClient, SignupClient,
    SupabasePlatformClient,
)

# Option A: Full signup → PAT (manual captcha token)
ew = EmailWorkerClient(base_url="https://mail-api.privatimail.com", token="<token>")
auto = OnboardingAutomation.for_signup(email_worker=ew)
report = auto.run_full(
    email="user@privatimail.com",
    password="StrongPassword123!",
    challenge_token="P1_eyJ...",  # from browser devtools
    pat_name="my-automation-token",
    pat_expires_in_days=365,
)
print(report.summary())
# report.pat is the sbp_... token — save it

# Option B: Operate on an existing account (PAT)
client = SupabasePlatformClient(access_token="sbp_...")
from supabase_onboarding import create_access_token
token = create_access_token(client, name="another-token", expires_in_days=30)
print(token.token)  # sbp_...
```

---

## Auth modes in detail

### Mode 1 — JWT access_token (short-lived, 30 min)

After email verification, the `GET /auth/v1/verify` endpoint returns a
303 redirect to `https://app.supabase.com#access_token=<JWT>&...`. The
JWT is a standard GoTiny token valid for 1800 seconds (30 minutes).

Use this for the immediate post-verify operations (create profile, create
org, generate PAT). For anything longer-lived, generate a PAT.

### Mode 2 — PAT (long-lived, configurable)

The `sbp_...` token returned by `create_access_token()` works against
the same `api.supabase.com/platform/*` endpoints AND the public
Management API (`api.supabase.com/v1/*`). It's the recommended auth mode
for all follow-up operations after onboarding.

The PAT can also be used with the Supabase CLI:
```bash
supabase login --token sbp_...
```

---

## CLI reference

```
automate.py {verify,create-profile,create-org,list-orgs,
             create-pat,list-pats,delete-pat,
             signup,verify-email,run-full,
             signup-ext,run-full-ext,
             bridge-status} ...
```

| Subcommand | What it does |
|------------|--------------|
| `verify`                  | Read-only: print profile + orgs. |
| `create-profile`          | Create the platform profile (idempotent). |
| `create-org`              | Create a personal org (idempotent). |
| `list-orgs`               | List organizations. |
| `create-pat`              | Create a PAT (`sbp_...`). |
| `list-pats`               | List PATs (token value not returned). |
| `delete-pat`              | Delete a PAT by id. |
| `signup`                  | Plain HTTP signup (needs `--captcha-token`). |
| `verify-email`            | Poll email worker + follow verify link. |
| `run-full`                | Full flow: signup → verify → profile → org → PAT. |
| `signup-ext`              | Extension-based signup (manual captcha solve). |
| `run-full-ext`            | Extension-based full flow. |
| `bridge-status`           | Check the bridge daemon + extension connection. |

Run any subcommand with `--help` for full flag list.

Exit codes:
- `0` — success
- `1` — one or more operations failed
- `2` — auth failure (missing/invalid token)
- `3` — other API error
- `4` — missing required env vars or args

---

## Tests

```bash
# Offline unit tests (no live creds needed)
python -m pytest tests/
```

---

## Caveats & limits

- **Signup requires hCaptcha.** The web app gets the token from hCaptcha's
  JS SDK; the token is short-lived (~2 min) and browser-fingerprinted.
  Based on probing, Supabase's signup endpoint does NOT have a Cloudflare
  WAF blocking datacenter IPs (it returns a JSON 401 for invalid captcha
  tokens). However, we don't yet know whether Supabase uses hCaptcha
  enterprise mode (which would reject headless browser tokens for signup,
  like Notion does). If headless tokens are rejected, use the browser
  extension bridge (`signup-ext` / `run-full-ext`).

- **The `redirect_to` bug is on Supabase's side.** We work around it by
  stripping the param. If Supabase fixes the bug, the workaround becomes
  a no-op (the param is optional).

- **The JWT access_token expires in 30 minutes.** For any long-running
  operation, generate a PAT first and use that instead.

- **The PAT is shown ONCE at creation time.** The list endpoint returns
  only the masked `token_alias` (e.g. `sbp_5ca2••••••••••4752`). Save
  the full token somewhere safe when you create it.

- **Org creation always creates a PERSONAL free-tier org.** The HAR shows
  this is the dashboard's default behavior. For team/business orgs, the
  flow would be different (requires billing info — out of scope).

---

## License

MIT — see repository root. This project is not affiliated with Supabase.
"Supabase" is a trademark of Supabase Inc.
