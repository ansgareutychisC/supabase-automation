# Import Flow Analysis — JWT vs PAT Limitations

## The core problem

Supabase has a **dual-token auth model** that creates a fundamental limitation
for importing existing accounts:

| Token | Works on | Use case | Lifetime |
|-------|----------|----------|----------|
| **JWT** (access_token) | `/platform/*` dashboard API | Profile, org, PAT creation, dashboard ops | 30 min |
| **PAT** (`sbp_...`) | `/v1/*` public Management API | Projects, databases, functions, etc. | Configurable (default 30 days) |

This is **different from Todoist**, where a single PAT works for both the
documented REST API and the undocumented app API. For Supabase, the PAT and
JWT are separate tokens with separate scopes.

## What an imported account CAN do (PAT only)

When you import an existing Supabase account with only a PAT (`sbp_...`),
the worker can do everything the `/v1/*` Management API supports:

| Operation | Endpoint | Works with PAT? |
|-----------|----------|-----------------|
| List organizations | `GET /v1/organizations` | ✅ |
| List projects | `GET /v1/projects` | ✅ |
| Create project | `POST /v1/projects` | ✅ |
| Delete project | `DELETE /v1/projects/{ref}` | ✅ |
| Run SQL | `POST /v1/projects/{ref}/database/query` | ✅ |
| List/create API keys | `GET/POST /v1/projects/{ref}/api-keys` | ✅ |
| Manage branches | `/v1/projects/{ref}/branches/*` | ✅ |
| Manage read replicas | `/v1/projects/{ref}/read-replicas` | ✅ |
| Manage backups | `/v1/projects/{ref}/database/backups` | ✅ |
| Manage webhooks | `/v1/projects/{ref}/database/webhooks` | ✅ |
| Manage functions | `/v1/projects/{ref}/functions` | ✅ |
| Auth config | `PATCH /v1/projects/{ref}/config/auth` | ✅ |
| Storage buckets | `{ref}.supabase.co/storage/v1/bucket` | ✅ (with service_role key) |
| Team member management | `/v1/organizations/{slug}/members` | ✅ |

## What an imported account CANNOT do (requires JWT)

These operations use the undocumented `/platform/*` dashboard API, which
**only accepts JWTs** (returns `401 "JWT could not be decoded"` for PATs):

| Operation | Endpoint | Requires JWT? |
|-----------|----------|---------------|
| View/edit platform profile | `GET/POST /platform/profile` | ⚠️ JWT only |
| Create organization | `POST /platform/organizations` | ⚠️ JWT only |
| **Generate new PAT** | `POST /platform/profile/access-tokens` | ⚠️ JWT only |
| **Re-login / password reset** | `POST /auth/v1/recover` | ⚠️ JWT or captcha |
| Dashboard-only settings | `/platform/projects/{ref}/...` | ⚠️ JWT only |
| Billing/subscription | `/platform/organizations/{slug}/billing/*` | ⚠️ JWT only |

## Re-login flow limitation

The re-login flow (`POST /api/accounts/:id/relogin`) sends a password reset
email via `POST /auth/v1/recover`. This endpoint:
- Requires hCaptcha (so it goes through the extension)
- Does NOT require a JWT (it's a public endpoint — anyone can request a reset)

So **re-login DOES work for imported accounts** — it doesn't need the JWT.
The reset email goes to the account's email address, and the user clicks
the link to set a new password.

## Import recommendations

### What you SHOULD import

Import accounts where you have:
- ✅ The **PAT** (`sbp_...`) — for all `/v1/*` operations
- ✅ The **email** — for re-login flow
- ✅ The **password** — for manual login if needed
- ✅ The **user_id** (gotrue UUID) — for identification

This gives you full Management API access + fleet management + re-login.

### What you CANNOT import (without JWT)

You cannot import an account and then:
- ❌ Generate a new PAT (requires JWT → `/platform/profile/access-tokens`)
- ❌ Create a new organization (requires JWT → `/platform/organizations`)
- ❌ Access dashboard-only settings (requires JWT → `/platform/*`)

### Workaround: re-onboard to get a fresh JWT

If you need JWT-only operations on an imported account:
1. Use the re-login flow to get a password reset email
2. Follow the reset link (which gives you a fresh JWT via the verify redirect)
3. Use that JWT for `/platform/*` operations (valid for 30 min)
4. Generate a new PAT if needed

The worker's `relogin` endpoint does step 1. Steps 2-4 would need a new
"complete re-login" flow that follows the reset link + captures the JWT.
This is a future enhancement.

## Comparison with Todoist

| Aspect | Todoist | Supabase |
|--------|---------|----------|
| Single token for everything? | ✅ Yes (PAT works for both) | ❌ No (JWT for /platform/*, PAT for /v1/*) |
| Import gives full access? | ✅ Yes | ⚠️ Partial (v1/* only) |
| Re-login generates new PAT? | ✅ Yes | ❌ No (generates reset link only) |
| Can generate PAT from imported? | ✅ Yes | ❌ No (requires JWT) |

## Worker code adjustments

The worker's import endpoint already accepts the PAT, password, email, and
user_id. No code changes needed for basic import. However:

1. **The dashboard should show an "imported" badge** to indicate the account
   may have limited capabilities (no JWT for /platform/* ops)
2. **The "Generate PAT" button should be disabled** for imported accounts
   (since it requires a JWT we don't have)
3. **The re-login button should work** for imported accounts (it's a public
   endpoint)

These UI adjustments are future enhancements.

## Summary

Importing existing Supabase accounts is **worthwhile for fleet management**
and all `/v1/*` Management API operations. The main limitation is that you
cannot generate new PATs or access `/platform/*` dashboard endpoints without
a JWT — which requires either a fresh signup or completing the re-login flow
to get a new verify link.
