# Complete /platform/ Endpoint Discovery — Comprehensive

**Method**: Extracted JWT from browser localStorage via extension, then probed
`/platform/*` endpoints directly + navigated all dashboard pages.

All endpoints require **JWT** (not PAT). JWT expires in 30 min — use the
refresh endpoint (`POST /api/refresh-jwt`) to get a fresh one.

## Account / Profile endpoints

| Endpoint | Method | Status | What it returns |
|----------|--------|--------|-----------------|
| `/platform/profile` | GET | ✅ 200 | Full profile (id, email, gotrue_id, free_project_limit, etc.) |
| `/platform/profile` | PATCH | ✅ 200 | Update profile (first_name, last_name, mobile) |
| `/platform/profile/permissions` | GET | ✅ 200 | All permissions across orgs (actions, resources, roles) |
| `/platform/profile/access-tokens` | GET | ✅ 200 | List all PATs (masked aliases) |
| `/platform/profile/access-tokens` | POST | ✅ 201 | Create PAT (needs name, expires_at) |
| `/platform/profile/access-tokens/{id}` | DELETE | ✅ 200 | Delete a specific PAT |
| `/platform/profile/mfa` | GET | ❌ 404 | Not found |
| `/platform/profile/sessions` | GET | ❌ 404 | Not found |
| `/platform/profile/identities` | GET | ❌ 404 | Not found |
| `/platform/profile/audit-log` | GET | ❌ 404 | Not found |
| `/platform/profile/notifications` | GET | ❌ 404 | Not found |
| `/platform/profile/preferences` | GET | ❌ 404 | Not found |

## Organization endpoints

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/platform/organizations` | GET | ✅ 200 | List all orgs |
| `/platform/organizations` | POST | ✅ 201 | Create org (needs name, kind, tier) |
| `/platform/organizations/{slug}` | GET | ✅ 200 | Org details (includes stripe_customer_id!) |
| `/platform/organizations/{slug}` | PATCH | ✅ 200 | **Rename org** (body: {name: "..."}) |
| `/platform/organizations/{slug}` | DELETE | ✅ 200 | **Delete org** (immediate, irreversible!) |
| `/platform/organizations/{slug}/members` | GET | ✅ 200 | List members with roles |
| `/platform/organizations/{slug}/entitlements` | ✅ 200 | Feature access matrix |
| `/platform/organizations/{slug}/usage` | ✅ 200 | Usage metrics (MAU, storage, bandwidth) + costs |
| `/platform/organizations/{slug}/members/reached-free-project-limit` | ✅ 200 | Check if at free limit |
| `/platform/organizations/{slug}/projects` | ✅ 200 | List projects in org |
| `/platform/organizations/{slug}/audit` | GET | ⚠️ 400 | Needs Team/Enterprise plan + date range params |
| `/platform/organizations/{slug}/oauth/apps?type=authorized` | ✅ 200 | List OAuth apps (requires type param) |
| `/platform/organizations/{slug}/integrations` | ❌ 404 | Not a separate endpoint |
| `/platform/organizations/{slug}/settings` | ❌ 404 | Use PATCH on the org itself |

## Billing endpoints (read-only — mutations need Stripe)

| Endpoint | Method | Status | What it returns |
|----------|--------|--------|-----------------|
| `/platform/organizations/{slug}/billing/subscription` | GET | ✅ 200 | Current plan, period, payment_method_type, addons |
| `/platform/organizations/{slug}/billing/plans` | GET | ✅ 200 | Available plans (free/pro/team/enterprise) with prices |
| `/platform/organizations/{slug}/billing/invoices` | GET | ✅ 200 | Past invoices |
| `/platform/organizations/{slug}/billing/invoices/upcoming` | GET | ✅ 200 | Next invoice preview (amount, tax, line items) |
| `/platform/organizations/{slug}/billing/subscription` | POST | ❌ 404 | Plan change needs Stripe checkout (browser) |
| `/platform/organizations/{slug}/billing/subscription` | PATCH | ❌ 404 | Spend cap toggle needs Stripe (browser) |
| `/platform/organizations/{slug}/billing/payment-methods` | GET | ❌ 404 | Not a direct endpoint |
| `/platform/organizations/{slug}/billing/address` | GET | ❌ 404 | Not found |
| `/platform/organizations/{slug}/billing/stripe/checkout` | POST | ❌ 404 | Needs Stripe Elements iframe (browser) |
| `/platform/organizations/{slug}/billing/stripe/portal` | POST | ❌ 404 | Needs Stripe portal (browser) |

## Project endpoints (org-level + project-level)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/platform/projects` | GET | ✅ 200 | List all projects |
| `/platform/projects/available-regions` | GET | ✅ 200 | Requires `cloud_provider` + `organization_slug` params |
| `/platform/projects/{ref}` | GET | ✅ 200 | Project details (db_host, region, status) |
| `/platform/projects/{ref}/settings` | GET | ✅ 200 | Full settings (db_host, db_name, region, etc.) |
| `/platform/projects/{ref}/status` | GET | ✅ 200 | Project status (ACTIVE_HEALTHY, etc.) |
| `/platform/projects/{ref}/config/storage` | GET | ✅ 200 | Storage config (file size limit, features) |
| `/platform/projects/{ref}/config/postgrest` | GET | ✅ 200 | PostgREST config (db_schema, max_rows, etc.) |
| `/platform/projects/{ref}/config/database` | GET | ❌ 404 | Use `/v1/projects/{ref}/config/database` instead |
| `/platform/projects/{ref}/config/auth` | GET | ❌ 404 | Use `/v1/projects/{ref}/config/auth` instead |
| `/platform/projects/{ref}/secrets` | GET | ❌ 404 | Use `/v1/projects/{ref}/secrets` instead |
| `/platform/projects/{ref}/functions` | GET | ❌ 404 | Use `/v1/projects/{ref}/functions` instead |
| `/platform/projects/{ref}/database/backups` | GET | ❌ 404 | Use `/v1/projects/{ref}/database/backups` instead |
| `/platform/projects/{ref}/pg-meta/*` | GET | ❌ 404 | Not on /platform/ — likely on {ref}.supabase.co |
| `/platform/projects/{ref}/auth/users` | GET | ❌ 404 | Use Auth Admin API with service_role key |

**Key insight**: Most project-level config endpoints live on `/v1/*` (PAT-authenticated),
NOT `/platform/*`. The `/platform/*` surface is mainly for:
- Account/profile management
- Org management (create, delete, rename)
- Billing (read-only)
- Project settings/details (read-only)

## System endpoints

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/platform/notifications` | GET | ✅ 200 | User notifications |
| `/platform/telemetry/feature-flags` | GET | ✅ 200 | Feature flag state |
| `/platform/stripe/invoices/overdue` | GET | ✅ 200 | Check for overdue invoices |

## JWT Refresh

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `auth.supabase.io/auth/v1/token?grant_type=refresh_token` | POST | Anon key | Refreshes JWT. Refresh token ROTATES. |
| Worker: `/api/refresh-jwt` | POST | None (dev) | Wraps the above |

### JWT refresh flow

```python
from supabase_onboarding.token_manager import TokenManager

tm = TokenManager(access_token=jwt, refresh_token=refresh)
# ... later, when JWT might be expired ...
tokens = tm.get_valid_tokens()  # auto-refreshes if expired
jwt = tokens.access_token  # guaranteed valid
```

The refresh_token **rotates** on each refresh — store the new one. If the
refresh_token itself expires (after ~60 days of inactivity), you'll need to
re-login via the extension.

## What's now automatable

### ✅ Fully automatable (JWT, no browser)

**Account/Profile:**
- View profile (`GET /platform/profile`)
- Update profile (`PATCH /platform/profile` — first_name, last_name, mobile)
- View permissions (`GET /platform/profile/permissions`)
- List PATs (`GET /platform/profile/access-tokens`)
- Create PAT (`POST /platform/profile/access-tokens`)
- Delete PAT (`DELETE /platform/profile/access-tokens/{id}`)

**Organization:**
- List orgs (`GET /platform/organizations`)
- Create org (`POST /platform/organizations`)
- Get org details (`GET /platform/organizations/{slug}`) — includes Stripe customer ID
- **Rename org** (`PATCH /platform/organizations/{slug}`)
- **Delete org** (`DELETE /platform/organizations/{slug}`)
- List members (`GET /platform/organizations/{slug}/members`)
- View entitlements (`GET /platform/organizations/{slug}/entitlements`)
- View usage/costs (`GET /platform/organizations/{slug}/usage`)
- Check free project limit (`GET /platform/organizations/{slug}/members/reached-free-project-limit`)
- List OAuth apps (`GET /platform/organizations/{slug}/oauth/apps?type=authorized`)

**Billing (read-only):**
- View subscription (`GET /platform/organizations/{slug}/billing/subscription`)
- View available plans (`GET /platform/organizations/{slug}/billing/plans`)
- View invoices (`GET /platform/organizations/{slug}/billing/invoices`)
- Preview upcoming invoice (`GET /platform/organizations/{slug}/billing/invoices/upcoming`)

**Project (read-only via /platform/):**
- List projects (`GET /platform/projects`)
- Get project details (`GET /platform/projects/{ref}`)
- Get settings (`GET /platform/projects/{ref}/settings`)
- Get status (`GET /platform/projects/{ref}/status`)
- Get storage config (`GET /platform/projects/{ref}/config/storage`)
- Get PostgREST config (`GET /platform/projects/{ref}/config/postgrest`)
- Get available regions (`GET /platform/projects/available-regions`)

**System:**
- View notifications (`GET /platform/notifications`)
- View feature flags (`GET /platform/telemetry/feature-flags`)
- Check overdue invoices (`GET /platform/stripe/invoices/overdue`)

### ❌ Still requires browser (Stripe/interactive)

- Plan upgrade/downgrade (Stripe checkout)
- Spend cap toggle (Stripe)
- Payment method add/remove (Stripe Elements iframe)
- 2FA enrollment (no /platform/ endpoint)
- Session management (no /platform/ endpoint)
- Email change (no /platform/ endpoint)
- Account deletion (no /platform/ endpoint)
- Audit log (requires Team/Enterprise plan)

## Architecture (final)

```
JWT (30-min, refreshable via refresh_token):
  /platform/profile (GET/PATCH)
  /platform/profile/access-tokens (GET/POST/DELETE)
  /platform/profile/permissions (GET)
  /platform/organizations (GET/POST)
  /platform/organizations/{slug} (GET/PATCH/DELETE)
  /platform/organizations/{slug}/members (GET)
  /platform/organizations/{slug}/billing/* (GET)
  /platform/organizations/{slug}/usage (GET)
  /platform/organizations/{slug}/entitlements (GET)
  /platform/projects (GET)
  /platform/projects/{ref} (GET)
  /platform/projects/{ref}/settings (GET)
  /platform/projects/{ref}/config/{storage,postgrest} (GET)
  /platform/notifications (GET)
  /platform/telemetry/feature-flags (GET)

PAT (long-lived, sbp_...):
  /v1/* Management API (projects CRUD, functions, databases, etc.)

Browser extension (hCaptcha + Stripe):
  Signup (hCaptcha)
  Login (hCaptcha — to get fresh JWT)
  Plan change (Stripe checkout)
  Payment method (Stripe Elements iframe)
```
