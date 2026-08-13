# Supabase Token Types + Auth IdP Operations — Research

## Part 1: Token/Key Types

### The short answer

**Your `sbp_...` PAT is sufficient for all Management API automation.** It's the direct analog of Todoist's API token — a single full-access token. You do NOT need additional tokens for Management API operations.

However, if your automation also needs to **read/write project data** (Data API, Storage, Auth as IdP), you'll additionally need a **project-level secret key** (`sb_secret_...`) — which you can fetch programmatically via the PAT right after creating a project.

### All token/key types in Supabase

```
┌─────────────────────────────────────────────────────────────────┐
│  ACCOUNT LEVEL (Supabase platform)                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ PAT (sbp_...)  ← full Management API access, automation  │   │
│  │ OAuth2 tokens  ← scoped Management API, 3rd-party apps   │   │
│  │ Dashboard JWT  ← /platform/* endpoints (browser only)    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│  PROJECT LEVEL (per Supabase project)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ sb_publishable_...  ← replaces anon  (client, RLS)       │   │
│  │ sb_secret_...       ← replaces service_role (server)     │   │
│  │ JWT Signing Keys    ← asymmetric JWT signing (Auth)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  These are for accessing the project's DATA, not Management API │
└─────────────────────────────────────────────────────────────────┘
```

| # | Name | Format | Scope | What it does | How to get it |
|---|------|--------|-------|--------------|---------------|
| 1 | **PAT** | `sbp_...` | Account | Full Management API (`/v1/*`) | `POST /platform/profile/access-tokens` (our current approach) |
| 2 | **OAuth2 token** | opaque | Account, scoped | Same Management API but scoped | OAuth Apps flow (`/v1/oauth/*`) |
| 3a | **Publishable key** | `sb_publishable_...` | Project | Client-side access (replaces `anon`) | `POST /v1/projects/{ref}/api-keys` (via PAT) |
| 3b | **Secret key** | `sb_secret_...` | Project | Server-side access, bypasses RLS (replaces `service_role`) | `POST /v1/projects/{ref}/api-keys` (via PAT) |
| 4 | **Legacy anon/service_role** | JWT | Project | Deprecated, removed late 2026 | — |
| 5 | **JWT Signing Keys** | RSA/ECC keypair | Project Auth | Signs user JWTs asymmetrically | `POST /v1/projects/{ref}/config/auth/signing-keys` (via PAT) |
| 6 | **Dashboard JWT** | JWT | Account session | `/platform/*` endpoints | Browser login only |
| 7 | **OAuth 2.1 Server tokens** | JWT | Project IdP | Your project as OAuth IdP | Enable in Dashboard → Authentication → OAuth Server |

### Key clarifications

- **PAT is always full-access** — no scopes, no read-only mode. GitHub issues #18584 and #42041 request scoped PATs but Supabase says "planned, not imminent."
- **OAuth2 tokens are the scoped alternative** — use these if building a third-party integration acting on behalf of other users
- **Project-level keys** (`sb_publishable_`/`sb_secret_`) are NOT Management API tokens — they access the project's data API
- **Legacy `anon`/`service_role`** are deprecated — use the new `sb_publishable_`/`sb_secret_` keys instead

### Recommendation for our tool

1. **Keep the `sbp_...` PAT** as the primary credential — it's sufficient for everything on the Management API
2. **After creating a project**, fetch its `sb_secret_...` key via `GET /v1/projects/{ref}/api-keys?reveal=true` (using the PAT) if you need to seed project data
3. **Do NOT** generate legacy `service_role` keys — they're being removed late 2026
4. **Optional**: If building a multi-tenant SaaS where each user connects their own Supabase, switch to OAuth Apps for scoped access

---

## Part 2: Auth IdP Operations — API vs Dashboard-Only

### The short answer

**~90% of Supabase Auth configuration is API-automatable.** The Management API exposes a mega-endpoint `GET/PATCH /v1/projects/{ref}/config/auth` with 200+ fields covering providers, SMTP, templates, hooks, rate limits, MFA, sessions, etc. The Auth Admin API (`supabase.auth.admin.*` with service_role) handles per-user operations.

Only a few operations are genuinely dashboard-only.

### What CAN be automated via API

| Category | Operations | Endpoint |
|----------|-----------|----------|
| **Auth providers** | Enable/disable + credentials for ALL providers (Google, GitHub, Apple, Azure, Facebook, Twitter, Discord, Slack, Notion, Spotify, etc.) | `PATCH /v1/projects/{ref}/config/auth` fields `external_<provider>_enabled`, `_client_id`, `_secret` |
| **SAML SSO** | Full CRUD for SAML providers (metadata XML or URL, attribute mapping, domain routing) | `/v1/projects/{ref}/config/auth/sso/providers` |
| **Custom OAuth/OIDC** | Add your own IdP as a custom provider | `supabase.auth.admin.customProviders.createProvider()` |
| **Third-party auth** | Clerk, Firebase, Auth0, Cognito, WorkOS integrations | `/v1/projects/{ref}/config/auth/third-party-auth` |
| **JWT signing keys** | Full lifecycle: create standby → rotate → revoke → delete (zero-downtime) | `/v1/projects/{ref}/config/auth/signing-keys` |
| **JWT expiry** | Configure token lifetime | `jwt_exp` field |
| **Custom JWT claims** | Custom Access Token Hook (HTTP or Postgres function) | `hook_custom_access_token_*` fields |
| **Email templates** | All templates (invite, confirmation, recovery, magic link, reauth, email-change, MFA, etc.) | `mailer_subjects_*` + `mailer_templates_*_content` |
| **SMTP** | Custom SMTP server config | `smtp_*` fields |
| **Send Email Hook** | Custom email provider (Resend, React Email, etc.) | `hook_send_email_*` |
| **Auth Hooks** | Before/After User Created, Custom Access Token, Send SMS/Email, MFA/Password Verification | `hook_<name>_enabled`/`_uri`/`_secrets` |
| **Rate limits** | Anonymous, email sent, SMS sent, verify, token refresh, OTP | `rate_limit_*` fields |
| **CAPTCHA** | Enable + provider (hCaptcha, Turnstile) + secret | `security_captcha_*` |
| **Password policies** | Min length, required characters, HIBP check | `password_min_length`, `password_required_characters`, `password_hibp_enabled` |
| **MFA factors** | Enable/disable TOTP, WebAuthn, Phone MFA, Passkeys | `mfa_*_enroll_enabled`, `mfa_*_verify_enabled` |
| **Per-user MFA** | List/delete a user's MFA factors | `auth.admin.mfa.listFactors()` / `deleteFactor()` |
| **Sessions** | Time-box, inactivity timeout, single-session-per-user, refresh rotation | `sessions_timebox`, `sessions_inactivity_timeout`, `sessions_single_per_user` |
| **Anonymous auth** | Enable + conversion to permanent | `external_anonymous_users_enabled` |
| **OAuth 2.1 Server** | Enable + full OAuth client CRUD + secret regeneration | `supabase.auth.admin.oauthClients.*` |
| **User management** | Create, list, update, delete, invite, magic link, ban | `auth.admin.*` |
| **Identity linking** | Link/unlink identities (e.g., add GitHub to email user) | `linkIdentity()` / `unlinkIdentity()` |
| **Session revocation** | Revoke all sessions for a user | `auth.admin.signOut(jwt)` |

### What CANNOT be automated (dashboard-only)

| Operation | Status | Workaround |
|-----------|--------|------------|
| **Native user impersonation** | ❌ Dashboard-only | `generateLink()` with service_role creates a magic link (no audit trail) |
| **Bulk user import** | ❌ No bulk endpoint | Loop `createUser()` with rate-limit-aware batching |
| **Bulk user delete** | ❌ No bulk endpoint | Loop `deleteUser()` |
| **"Export all users" single call** | ⚠️ Paginated only | Loop `listUsers()` and aggregate |
| **Apple `.p8` key file upload UI** | ⚠️ Dashboard convenience | Self-sign the ES256 JWT from the `.p8` key + Team ID + Key ID — write to `external_apple_secret` |
| **"Migrate JWT secret" one-click button** | ⚠️ Dashboard convenience | Create new signing key via API + rotate |
| **Auth-endpoint IP allowlisting** | ❌ Not available | Network Restrictions covers DB only, not Auth HTTP API. Use rate limits + CAPTCHA |
| **Concurrent-session cap (N > 1)** | ❌ Not possible | Only single-session-per-user toggle exists |
| **"Enforce MFA for all users" global toggle** | ⚠️ No config switch | Enforcement via RLS on `aal` claim (application-level) |
| **Built-in multi-tenant auth** | 🚫 Not a product | Build with `tenant_id` schema + RLS + SAML domain-mapping for B2B SSO |

### Plan-gated features (require paid plans)

| Feature | Plan required |
|---------|--------------|
| Session policies (timebox, inactivity, single-session) | **Pro+** |
| Enterprise SSO (SAML) | **Pro+** |
| MFA Verification Attempt Hook | **Teams/Enterprise** |
| Password Verification Attempt Hook | **Teams/Enterprise** |

### Recommendations for our onboarding tool

1. **Drive Auth config through `PATCH /v1/projects/{ref}/config/auth`** — it's the single richest endpoint. One GET + one PATCH can snapshot/restore an entire Auth config.

2. **Use Auth Admin API** (`supabase.auth.admin.*` with `sb_secret_...`) for user/identity/MFA/OAuth-client operations.

3. **For Apple Sign-In**, build a small ES256 JWT-signing utility (Node `jose` / Python `authlib`) that takes the `.p8` key + Team ID + Key ID + Services ID and emits the 6-month `client_secret` — write to `external_apple_secret`. Schedule 5-month rotation.

4. **For JWT signing keys**, script the full sequence: create standby → rotate → wait (JWT exp + 15 min) → revoke old. Zero-downtime rotation is fully automatable.

5. **For hooks pointing to Edge Functions**, deploy the function first via `POST /v1/projects/{ref}/functions`, then enable `hook_*_enabled` + `_uri` in config. Two-step orchestration.

6. **For bulk user operations**, implement client-side loops with rate-limit-aware batching. Warn users these are slower than a native bulk API.

7. **For multi-tenancy**, generate the RLS policy SQL + `tenant_id` schema via the Database Migration endpoints. Use SAML domain-mapping for B2B SSO routing.

8. **Capability-detection**: `GET /v1/projects/{ref}/config/auth` first and diff against a known-good template rather than blindly PATCHing all fields — avoids clobbering customer-specific values.

---

## Sources

### Token types
- https://supabase.com/docs/reference/api/introduction
- https://supabase.com/docs/guides/getting-started/api-keys
- https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- https://supabase.com/blog/jwt-signing-keys (Jul 2025)
- https://supabase.com/blog/supabase-security-2025-retro (Jan 2026)
- https://github.com/orgs/supabase/discussions/29260 (API keys changes)
- https://github.com/supabase/supabase/issues/18584 (scoped PATs request)
- https://github.com/orgs/supabase/discussions/42041 (scoped API keys)
- https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
- https://supabase.com/docs/guides/auth/oauth-server/getting-started
- https://supabase.com/docs/guides/platform/temporary-access (PAT as Postgres password)

### Auth IdP operations
- https://supabase.com/docs/reference/api/introduction (Auth config endpoints)
- https://supabase.com/docs/guides/auth (all auth guides)
- https://supabase.com/docs/guides/auth/signing-keys
- https://supabase.com/docs/guides/auth/auth-hooks
- https://supabase.com/docs/guides/auth/mfa
- https://supabase.com/docs/guides/auth/sso
- https://supabase.com/docs/reference/javascript/auth-admin-api
- https://supabase.com/docs/guides/auth/oauth-server/getting-started
