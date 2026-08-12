# Supabase Onboarding Worker

A Cloudflare Worker that runs the full Supabase account onboarding pipeline
server-side, with a built-in HTML dashboard UI and D1-backed fleet management.

This is the CF Worker equivalent of the Python backend (`automate.py`), adapted
from the [notion-onboarding-automation](https://github.com/ansgareutychisC/notion-onboarding-automation)
worker architecture.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (Hono app)                                │
│  ├── GET /  → Dashboard HTML UI (fleet manager)              │
│  ├── POST /api/run → Start onboarding pipeline (async)       │
│  ├── GET /api/accounts → List all accounts                   │
│  ├── POST /api/accounts/import → Import existing account     │
│  ├── POST /api/accounts/export → Export all accounts (JSON)  │
│  ├── POST /api/accounts/:id/relogin → Password reset flow    │
│  └── GET /api/jobs → Job history                             │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  BridgeHub Durable Object                            │    │
│  │  ├── Holds WebSocket to Chrome extension             │    │
│  │  ├── sendCommand() → tabs.open, form.fill, etc.     │    │
│  │  └── fetchViaExtension() → fetch() in browser ctx    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  D1 Database (accounts, jobs)                                │
└─────────────────────────────────────────────────────────────┘
         │                                │
         │ WebSocket                      │ Direct fetch()
         ▼                                ▼
┌─────────────────────┐         ┌─────────────────────┐
│  Chrome Extension   │         │  api.supabase.com    │
│  ├── Opens signup   │         │  /platform/profile    │
│  │   page            │         │  /platform/orgs       │
│  ├── Fills form     │         │  /platform/pat        │
│  ├── Waits for      │         └─────────────────────┘
│  │   hCaptcha solve  │
│  └── Clicks submit   │         ┌─────────────────────┐
└─────────────────────┘         │  mail-api.privatimail │
         │                      │  .com (email worker)  │
         │ hCaptcha token       └─────────────────────┘
         ▼                                ▲
┌─────────────────────┐                   │
│  supabase.com/      │───────────────────┘
│  dashboard/sign-up  │  (verify email sent here)
└─────────────────────┘
```

### Why Durable Objects?

The signup step requires hCaptcha, which can only be solved in a real browser.
The BridgeHub Durable Object holds the WebSocket connection to the Chrome
extension, allowing the worker to send commands (open page, fill form, click
submit) and wait for the user to solve the captcha.

After signup, steps 2-7 (email verify, profile, org, PAT) use direct `fetch()`
from the worker — Supabase has no WAF on these endpoints (confirmed via live
probing).

## What's automated

| # | Operation | How | Extension needed? |
|---|-----------|-----|-------------------|
| 1 | Sign up new account | Extension: tabs.open + form.fill + form.click | ✅ Yes (hCaptcha) |
| 2 | Poll for verify email | Direct fetch to mail-api.privatimail.com | ❌ No |
| 3 | Follow verify link (strip redirect_to) | Direct fetch, parse 303 Location | ❌ No |
| 4 | Get user | Direct fetch to auth.supabase.io | ❌ No |
| 5 | Create platform profile | Direct fetch to api.supabase.com/platform/profile | ❌ No |
| 6 | Create organization | Direct fetch to api.supabase.com/platform/organizations | ❌ No |
| 7 | Generate PAT | Direct fetch to api.supabase.com/platform/profile/access-tokens | ❌ No |

## Deploy

Prerequisites:
- A Cloudflare account with Workers + Durable Objects + D1 enabled
- The `EMAIL_WORKER_TOKEN` secret (bearer token for mail-api.privatimail.com)
- The Chrome extension loaded and connected

```bash
cd worker/
npm install

# Create D1 database
npx wrangler d1 create supabase-onboarding
# Copy the database_id from the output into wrangler.toml

# Run migrations
npx wrangler d1 execute supabase-onboarding --file=migrations/0001_init.sql

# Set secrets
echo "<email-worker-bearer>" | npx wrangler secret put EMAIL_WORKER_TOKEN
echo "<bridge-auth-token>"   | npx wrangler secret put BRIDGE_TOKEN

# Deploy
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

The deploy output gives you the `*.workers.dev` URL. Open it in a browser
to access the dashboard.

## Using the dashboard

1. Open the worker URL in a browser
2. Check the "Extension Status" card — it should show "✓ 1 extension connected"
3. If not, load the Chrome extension (from `extension/`) and set its Server URL
   to `wss://<worker-url>/ws`
4. Fill in the "Create New Account" form (or leave blank for auto-generated)
5. Click "Run Full Pipeline"
6. The extension opens the Supabase signup page — solve the hCaptcha when it appears
7. The worker polls for the verify email, follows the link, creates profile/org/PAT
8. The PAT is displayed in the result (highlighted in yellow)

## Fleet management

- **Accounts** tab: list all onboarded accounts with org, PAT alias, status
- **Show PAT**: click the "PAT" button to reveal the full `sbp_...` token
- **Re-login**: sends a password reset email (routes through the extension for hCaptcha)
- **Import**: manually add an existing account (email, password, PAT, user_id)
- **Export**: download all accounts as JSON for backup
- **Delete**: remove an account from D1

## Re-login flow

The re-login feature sends a password reset email to the account's address.
This uses the `POST /auth/v1/recover` endpoint, which also requires hCaptcha —
so it's routed through the extension's browser context.

The reset link is captured from the email worker and displayed in the dashboard.
The user clicks the link to set a new password. The temporary password (from
the original signup) is also stored in D1 and can be retrieved via the API
for manual login.

## Cookie/session replay

The worker stores `cookies` and `session_data` columns in D1. These are
populated when the extension captures cookies during the signup flow (via
`cookies.getAll`). The data can be used to replay the session in another
browser or context.

Note: cookies are IP-bound in some cases (Cloudflare `__cf_bm`), so replay
may not work from a different IP. The JWT access_token and PAT are NOT
IP-bound and work from anywhere.

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/` | Dashboard HTML UI |
| `GET`  | `/health` | Liveness probe |
| `GET`  | `/api/token` | Bridge auth token (for extension) |
| `GET`  | `/api/extensions` | Extension connection status |
| `GET`  | `/api/accounts` | List all accounts |
| `GET`  | `/api/accounts/:id` | Single account (by email or user_id) |
| `GET`  | `/api/accounts/:id/pat` | Reveal full PAT |
| `POST` | `/api/accounts/import` | Import existing account |
| `POST` | `/api/accounts/export` | Export all accounts as JSON |
| `DELETE` | `/api/accounts/:id` | Delete account |
| `POST` | `/api/accounts/:id/relogin` | Send password reset email |
| `GET`  | `/api/jobs` | Job history |
| `POST` | `/api/run` | Run full pipeline (async) |
| `WS`   | `/ws` | Extension WebSocket connection |
| `WS`   | `/ws/dashboard` | Dashboard live updates |

## JWT vs PAT auth split

- **JWT** (30-min, from verify) → `/platform/*` dashboard API (profile, org, PAT creation)
- **PAT** (`sbp_...`, long-lived) → `/v1/*` public Management API (projects, databases)

The worker stores both in D1. The PAT is the primary output — use it with
`supabase login --token sbp_...` for all future operations.
