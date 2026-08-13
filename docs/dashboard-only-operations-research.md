# Supabase Operations Without API Support — Comprehensive Research

Research conducted via 3 parallel subagents covering:
1. Project pause/wake/dormancy + free tier limits
2. Dashboard-only operations across all Supabase surfaces
3. CLI source code analysis for hidden `/platform/` endpoints

---

## Quick Answer: Pause/Wake + 2-Project Limit

**Can you pause a project?** ✅ Yes — `POST /v1/projects/{ref}/pause` (documented API)
**Can you wake a paused project?** ✅ Yes — `POST /v1/projects/{ref}/restore` (documented API)
**Can you exceed 2 free projects?** ✅ Yes — paused projects don't count toward the limit
**Auto-pause?** ⚠️ Yes, after 7 days of low DB activity (free plan only)

### The cycling strategy (works, by design)
1. Create 2 free projects (max active)
2. Pause one via `POST /v1/projects/{ref}/pause` — frees up a slot
3. Create a 3rd project
4. Restore the paused one later via `POST /v1/projects/{ref}/restore`
5. Repeat as needed (1-year restore window)

### Preventing auto-pause
- **Official**: Upgrade to Pro (paid projects never auto-pause)
- **Community**: GitHub Actions cron that runs a DB query every few days to reset the 7-day inactivity timer
- **Caveat**: The ping must hit the database (not just a cached edge endpoint)

**Sources**:
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/platform/billing-on-supabase
- https://api.supabase.com/api/v1 (confirms `pause` + `restore` endpoints)

---

## Dashboard-Only Operations (No API, No CLI)

These operations have **zero `/v1/` API coverage** and **no CLI command** — they can only be done via the Supabase dashboard UI:

### Organization Management
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Delete organization | ✅ Dashboard only | No `DELETE /v1/organizations/{id}` |
| Rename organization | ✅ Dashboard only | No `PATCH /v1/organizations/{id}` |
| Change org owner / transfer ownership | ✅ Dashboard only | Must promote member to Owner, then leave |
| Change org billing email | ✅ Dashboard only | No billing API endpoints |

### Account / Profile
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Delete / close Supabase account | ✅ Dashboard only | No `DELETE /v1/profile` |
| Change account email | ✅ Dashboard only | Dashboard → Account Settings → Identities |
| Change account password | ✅ Dashboard only | No `/v1/profile/password` |
| Enable / disable account 2FA | ✅ Dashboard only | Account-level MFA (not app-user MFA) |
| Manage account sessions | ✅ Dashboard only | No session-management API |
| Create / delete PATs | ✅ Dashboard only | "Visit your account page" per docs |

### Billing (entire category — no API at all)
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Add / remove payment method | ✅ Dashboard only | Stripe redirect |
| Change plan (upgrade/downgrade) | ✅ Dashboard only | GitHub discussion #32609 requests this |
| Cancel subscription | ✅ Dashboard only | Downgrade to Free via dashboard |
| View / download invoices | ✅ Dashboard only | No invoice API |
| Add billing address / tax ID | ✅ Dashboard only | Org billing page only |

### Database
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Enable/disable Postgres extensions | ✅ Dashboard only | Workaround: `CREATE EXTENSION` via SQL API |

### Integrations
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Authorize GitHub connection | ✅ Dashboard only | API can list only, not create |
| Connect Vercel / Netlify | ✅ Dashboard only | Marketplace OAuth install |
| Slack notifications | ✅ Dashboard only | Not a native platform feature |

### Notifications
| Operation | Dashboard-only? | Notes |
|-----------|----------------|-------|
| Email notification preferences | ✅ Dashboard only | Account Settings → Preferences |
| Usage alert configuration | ✅ Dashboard only | No alert-threshold API |

---

## Not Possible At All (No API, No CLI, No Dashboard)

| Operation | Status | Notes |
|-----------|--------|-------|
| In-place region change | 🚫 Not possible | Must create new project + migrate |
| Full project clone/duplicate | 🚫 Not possible | Only database-only restore exists |
| Force-disconnect active DB connections | 🚫 Not possible | Must restart or `pg_terminate_backend` via SQL |
| User-controlled maintenance windows | 🚫 Not possible | Platform-controlled |
| Restore project paused >1 year | 🚫 Not possible | Must download backup + `pg_restore` |

---

## API-Supported But No CLI Wrapper

These ARE in the Management API but the CLI doesn't expose them — useful for our automation:

| Operation | API Endpoint | CLI? |
|-----------|-------------|------|
| **Pause project** | `POST /v1/projects/{ref}/pause` | ❌ |
| **Restore/unpause project** | `POST /v1/projects/{ref}/restore` | ❌ |
| Restart project | `POST /v1/projects/{ref}/restart` | ❌ |
| Transfer project | `POST /v1/projects/{ref}/transfer` | ❌ |
| Upgrade Postgres version | `POST /v1/projects/{ref}/upgrade` | ❌ |
| Update database password | `PATCH /v1/projects/{ref}/config/database` | ❌ |
| Run SQL query | `POST /v1/projects/{ref}/database/query` | ❌ (uses direct pgx) |
| Manage org members/roles | `/v1/organizations/{slug}/members` | ❌ |
| Apply/remove billing add-ons | `/v1/projects/{ref}/addons` | ❌ |
| Create/rotate API keys | `/v1/projects/{ref}/api-keys` | ❌ (CLI lists only) |
| Manage read replicas | `/v1/projects/{ref}/read-replicas` | ❌ |
| List backups / PITR restore | `/v1/projects/{ref}/database/backups/*` | ❌ |
| Manage log drains | `/v2/projects/{ref}/analytics/log-drains` | ❌ |
| Network restrictions | `/v1/projects/{ref}/network-restrictions` | ✅ (`--experimental`) |
| SSL enforcement | `/v1/projects/{ref}/ssl-enforcement` | ✅ (`--experimental`) |
| Custom domains | `/v1/projects/{ref}/custom-hostname/*` | ✅ |
| Connection pooler config | `PATCH /v1/projects/{ref}/config/pooler` | ❌ |

---

## CLI Source Code Analysis — Hidden `/platform/` Endpoints

The CLI was analyzed at tag `v2.20.5` (Go source). Findings:

**There is only ONE undocumented `/platform/` endpoint in the entire CLI:**

```
GET https://api.supabase.com/platform/cli/login/{session_id}
```

- Used by `supabase login` (browser-based OAuth-like flow)
- Returns an ECDH-encrypted access token
- **Not useful for automation** — use a PAT (`sbp_...`) instead

**All other CLI commands use:**
1. The OpenAPI-generated `pkg/api` client → documented `/v1/` endpoints
2. Direct Postgres connections (`pgx` driver to `db.{ref}.supabase.co:5432`) — **cannot be replicated via HTTP**
3. Per-project tenant APIs (`{ref}.supabase.co/{auth,rest,storage}/v1/`)
4. Docker for local dev commands

**Key insight**: The CLI's "superpower" over the API is the **direct Postgres connection** (for `db push`, `inspect db`, `migration repair`, etc.). This cannot be replicated via HTTP — Supabase deliberately doesn't expose DDL/migration mutation over the Management API.

---

## Implications for Our Automation Tool

### What we CAN automate with a PAT (no JWT needed)
- ✅ Project lifecycle: create, list, delete, **pause, restore, restart, transfer, upgrade**
- ✅ Database: run SQL, update password, manage backups/PITR
- ✅ Functions: deploy, list, delete, download
- ✅ Branches: create, merge, reset, pause/unpause (preview branches)
- ✅ Read replicas: create, list, delete
- ✅ Network restrictions, SSL enforcement, custom domains
- ✅ Org member management: invite, list, remove, change roles
- ✅ API keys: create, list, rotate, delete
- ✅ Billing add-ons: apply/remove (project-level only)
- ✅ All config: auth, storage, postgrest, pooler, postgres

### What we CANNOT automate (dashboard-only, needs JWT + browser)
- ❌ Organization: delete, rename, change owner, change billing email
- ❌ Account: delete, change email, change password, 2FA, sessions, PATs
- ❌ Billing: payment methods, plan changes, invoices, billing address
- ❌ Postgres extensions (workaround: SQL via `/v1/.../database/query`)
- ❌ Third-party integrations: GitHub, Vercel, Netlify, Slack
- ❌ Notification preferences

### What requires the browser extension (hCaptcha or interactive flow)
- 🔧 Signup (hCaptcha) — already implemented
- 🔧 Re-login / password reset (hCaptcha) — already implemented
- 🔧 Accept org transfer (interactive)
- 🔧 Authorize GitHub/Vercel integrations (OAuth redirect)

### Cycling projects to bypass the 2-free-project limit
Since pause/restore are API-supported:
1. Add `POST /v1/projects/{ref}/pause` to our worker
2. Add `POST /v1/projects/{ref}/restore` to our worker
3. The fleet dashboard can show pause/restore buttons
4. Document the cycling strategy in the README

This is **fully automatable** with just a PAT — no browser needed.

---

## Sources

### Pause/Wake/Limits
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/platform/billing-on-supabase
- https://supabase.com/pricing
- https://api.supabase.com/api/v1 (OpenAPI spec)
- https://github.com/orgs/supabase/discussions/9152
- https://github.com/orgs/supabase/discussions/13776
- https://supabase.com/docs/guides/troubleshooting/pausing-pro-projects-vNL-2a
- https://supabase.com/docs/guides/troubleshooting/keeping-free-projects-after-pro-upgrade-Kf9Xm2

### Dashboard-only operations
- https://supabase.com/docs/reference/api/introduction
- https://supabase.com/docs/reference/cli/introduction
- https://supabase.com/docs/guides/platform/access-control (role matrix)
- https://supabase.com/docs/guides/platform/delete-project
- https://supabase.com/docs/guides/platform/project-transfer
- https://supabase.com/docs/guides/platform/manage-your-subscription
- https://supabase.com/docs/guides/platform/multi-factor-authentication
- https://github.com/orgs/supabase/discussions/32609 (change plan programmatically)
- https://github.com/supabase/supabase/issues/40631 (delete org)

### CLI source analysis
- https://github.com/supabase/cli (tag v2.20.5, Go source)
- `internal/login/login.go` — the only `/platform/` endpoint
- `internal/utils/api.go` — OpenAPI-generated client
- `pkg/api` — generated from OpenAPI spec

### Community workarounds for auto-pause
- https://github.com/travisvn/supabase-pause-prevention
- https://dev.to/jps27cse/how-to-prevent-your-supabase-project-database-from-being-paused-using-github-actions-3hel
- https://levelup.gitconnected.com/supabase-free-tier-will-pause-your-app-heres-the-github-actions-fix-8c1fd35b49ca
