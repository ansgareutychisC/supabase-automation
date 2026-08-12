# Supabase Dashboard HAR Capture Research

## Summary

Research into which Supabase dashboard operations require manual user action
(i.e., NOT available via the official Management API at `api.supabase.com/v1/*`).

The key finding: **the official `/v1/*` API is much broader than initially
assumed**. It covers branches, read replicas, PITR backups, webhooks, cron,
auth config, network restrictions, SSL enforcement, member management, and
SQL execution. The truly undocumented `/platform/*` surface is narrower
than expected.

## Confirmed /v1/ endpoints (documented, use directly)

| Operation | Endpoint | Source |
|-----------|----------|--------|
| Run SQL query | `POST /v1/projects/{ref}/database/query` | docs/reference/api/v1-run-a-query |
| Get database context | `GET /v1/projects/{ref}/database/context` | docs (dual rate-limited: 10/min + 1/interval) |
| Get logs | `GET /v1/projects/{ref}/endpoints/logs.all` | docs (30-req limit) |
| Restore branch | `POST /v1/projects/{ref}/branches/{id}/restore` | docs/reference/api/v1-restore-a-branch |
| Create API signing key | `POST /v1/projects/{ref}/api-keys` | docs/reference/api/v1-create-project-signing-key |
| Update legacy API keys | `PATCH /v1/projects/{ref}/api-keys` | docs/reference/api/v1-update-project-legacy-api-keys |
| Create project | `POST /v1/projects` | docs/reference/api/v1-create-a-project |
| Update project | `PATCH /v1/projects/{ref}` | docs |
| List/read orgs | `GET /v1/organizations` | docs |
| List/create members | `/v1/organizations/{slug}/members` | docs |
| Manage branches | `/v1/projects/{ref}/branches/*` | docs |
| Manage read replicas | `/v1/projects/{ref}/read-replicas` | docs |
| Manage backups/PITR | `/v1/projects/{ref}/database/backups` | docs |
| Manage webhooks | `/v1/projects/{ref}/database/webhooks` | docs |
| Manage functions | `/v1/projects/{ref}/functions` | docs |
| Auth provider config | `PATCH /v1/projects/{ref}/config/auth` | docs |
| Storage buckets | `{ref}.supabase.co/storage/v1/bucket` | docs |

## Priority HAR capture list

### 🥇 1. Billing — add payment method + upgrade plan (HIGH)
- **Endpoints**: `/platform/organizations/{slug}/billing/*` → Stripe redirect
- **Why**: Biggest undocumented gap; blocks all non-free project creation
- **HAR actions**: Add payment method (Stripe redirect + webhook), upgrade plan, downgrade, view invoices
- **Gatcha**: Stripe Elements iframe may require headless browser

### 🥈 2. JWT Templates — create/edit/delete (HIGH)
- **Endpoints**: `GET/POST/DELETE /platform/projects/{ref}/auth/jwt-templates` (unconfirmed)
- **Why**: Genuine /v1/ gap; commonly needed in onboarding
- **HAR actions**: Create JWT template, edit one, delete one
- **Fields**: name, value (claims JSON), secret (signing key), expires_at

### 🥉 3. Table Editor — create table + add column (HIGH)
- **Endpoints**: `/platform/pg-meta/{ref}/*` or pg-meta proxy (unconfirmed)
- **Why**: The pg-meta DDL-generation calls are undocumented
- **HAR actions**: New Table → add columns → save; Edit Table → add column → save
- **Workaround**: Use SQL via `POST /v1/projects/{ref}/database/query` instead

### 4. Project creation — full wizard (MEDIUM)
- **Endpoint**: `POST /v1/projects` (documented) + pre-checks
- **Why**: Capture payment-method presence check, post-creation health polling, org slug→ID resolution
- **HAR actions**: Full project creation flow including plan selection

### 5. Team member invite — full flow (MEDIUM)
- **Endpoint**: `/v1/organizations/{slug}/members` (documented) + acceptance endpoint
- **Why**: Invite is documented but acceptance flow (email link → dashboard → API call) is not
- **HAR actions**: Invite member, accept invite via email link

### 6. Project settings — change DB password (MEDIUM)
- **Endpoint**: `PATCH /v1/projects/{ref}/config/database` or `/platform/...` (unconfirmed)
- **Why**: Rename is documented but password-change endpoint is uncertain
- **HAR actions**: Change database password in settings

### 7. Edge Functions — deploy from dashboard (MEDIUM)
- **Endpoint**: `POST /v1/projects/{ref}/functions/{id}/deploy` (multipart, unconfirmed)
- **Why**: Confirm multipart source-upload body format
- **HAR actions**: Deploy a function from the dashboard
- **Workaround**: Use `supabase functions deploy` CLI instead

## Additional undocumented flows discovered

| Flow | Likely endpoint | Priority |
|------|----------------|----------|
| Project transfer between orgs | `POST /platform/projects/{ref}/transfer` | Medium |
| 2FA/MFA setup | `/platform/profile/mfa/enroll` | Low |
| Custom domains | `GET/POST /v1/projects/{ref}/custom-hostname` | Medium |
| Third-party app integrations | `/platform/profile/integrations/*` | Low |

## Recommended action

1. **First**: Open `https://api.supabase.com/api/v1` in a browser and extract
   the embedded OpenAPI JSON — this gives the complete authoritative `/v1/`
   endpoint list in one shot, eliminating more HAR captures.

2. **Then**: Capture HARs for items 1-3 in priority order (billing, JWT
   templates, table editor). These are the genuine `/platform/*` gaps.

3. **Skip**: Branches, replicas, backups, webhooks, storage, SQL, logs, auth
   config, API keys — all documented in `/v1/`.
