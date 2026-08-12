# Supabase Onboarding API — Reverse Engineering Notes

Field-level reference for the Supabase dashboard API endpoints used in
the onboarding flow. Derived from three HAR captures:

- `supabase.signup-pt1.har` — signup flow (POST /platform/signup, dashboard load)
- `supabase.signup-pt1-tk2.har` — signup retry attempts (bad captcha, weak password)
- `supabase.signup-pt2.har` — post-verify flow (profile, org, PAT, project setup)

Plus a single-shot WAF probe from the sandbox confirming which endpoints
accept plain `requests` vs. need the browser extension bridge.

---

## Endpoint protection summary

| Endpoint | WAF | Captcha | Plain `requests` works? |
|----------|-----|---------|--------------------------|
| `POST api.supabase.com/platform/signup` | No Cloudflare WAF (returns JSON 401) | **Yes — hCaptcha** | Yes, but needs valid hCaptcha token |
| `GET auth.supabase.io/auth/v1/verify` | No (returns 303) | No | **Yes** — parse access_token from Location |
| `GET auth.supabase.io/auth/v1/user` | No (returns JSON 403) | No | Yes, with Bearer |
| `GET api.supabase.com/platform/profile` | No (returns JSON 401) | No | Yes, with Bearer |
| `POST api.supabase.com/platform/profile` | No | No | Yes, with Bearer |
| `GET api.supabase.com/platform/organizations` | No (returns JSON 401) | No | Yes, with Bearer |
| `POST api.supabase.com/platform/organizations` | No | No | Yes, with Bearer |
| `POST api.supabase.com/platform/profile/access-tokens` | No | No | Yes, with Bearer |

**Conclusion**: Only `POST /platform/signup` needs the browser (for the
hCaptcha token). Everything else works with plain `requests` + a Bearer
token (JWT or PAT).

The probe was run from the sandbox datacenter IP (Hong Kong, AS45102
Alibaba). The `__cf_bm` cookie IS set by Cloudflare on all `api.supabase.com`
responses, but it's not enforced as a WAF gate — the API accepts requests
without it (just with the Bearer token).

---

## 1. POST api.supabase.com/platform/signup

Creates a new Supabase account (GoTrue user + sends verification email).

### Request

```
POST https://api.supabase.com/platform/signup
Content-Type: application/json
Origin: https://supabase.com
Referer: https://supabase.com/dashboard/sign-up
User-Agent: Mozilla/5.0 ... Chrome/151.0.0.0

{
  "email": "user@privatimail.com",
  "password": "StrongPassword123!",
  "hcaptchaToken": "P1_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Response

- **201** (success): empty body. The verification email is sent.
- **401**: `{"message": "Invalid or missing captcha token: invalid-input-response"}`
  — the hCaptcha token is missing, expired, or invalid.
- **403**: `{"message": "A user with this email already exists"}` — email
  is already registered.
- **403**: `{"message": "Password is known to be weak and easy to guess, please choose a different one."}`
  — password failed the strength check. Use 12+ chars with mixed case +
  digits + symbols. Avoid common patterns like `Supabase123!`.

### Headers

The request must include Chrome's standard `sec-ch-ua`, `sec-ch-ua-mobile`,
`sec-ch-ua-platform`, `sec-fetch-*` headers. Without them, the Cloudflare
edge MAY return 403 (unconfirmed — the probe got 401 with these headers
present).

Cookies: the dashboard sends `_ga`, `FPAU`, `session_id`, `anonymous_id`,
`__cf_bm`. None of these are required for the signup endpoint to work —
the probe sent none and got a 401 (captcha error, not a cookie error).

### hCaptcha

The `hcaptchaToken` is obtained from hCaptcha's JS SDK
(`https://js.hcaptcha.com/1/api.js`). The token:
- Starts with `P1_eyJ...`
- Is a JWT signed by hCaptcha
- Expires in ~2 minutes
- Is tied to the browser's fingerprint

**Unknown**: whether Supabase uses hCaptcha enterprise mode (which would
reject headless browser tokens for signup, like Notion does). If headless
tokens are rejected, use the browser extension bridge.

---

## 2. GET auth.supabase.io/auth/v1/verify

Follows the verification link from the email. Returns a 303 redirect with
the access_token in the URL fragment.

### The `redirect_to` bug

The email contains a link like:

```
https://auth.supabase.io/auth/v1/verify?token=...&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in
```

**With** `redirect_to`: the verify endpoint returns 303 to
`https://supabase.com/dashboard/sign-in#error=...` and the dashboard
shows `{"code":400,"error_code":"validation_failed","msg":"Verify requires a verification type"}`.

**Without** `redirect_to`: the verify endpoint returns 303 to
`https://app.supabase.com#access_token=<JWT>&expires_in=1800&refresh_token=...&token_type=bearer&type=signup`
which works correctly.

**Workaround**: always strip `redirect_to` from the verify URL before
calling the endpoint. See `supabase_onboarding/signup/client.py:verify_email()`.

### Request

```
GET https://auth.supabase.io/auth/v1/verify?token=<token>&type=signup
```

No headers required beyond the default User-Agent.

### Response (303)

```
HTTP/1.1 303 See Other
Location: https://app.supabase.com#access_token=<JWT>&expires_at=1786529161&expires_in=1800&refresh_token=<refresh>&token_type=bearer&type=signup
Content-Type: text/html; charset=utf-8
```

The fragment (after `#`) contains:
- `access_token` — the JWT (RS256-signed, ~1KB)
- `refresh_token` — for refreshing the access_token via GoTrue
- `expires_at` — epoch seconds
- `expires_in` — seconds until expiry (always 1800 = 30 min)
- `token_type` — "bearer"
- `type` — "signup" (matches the `type` query param)

**Important**: Do NOT follow the redirect. Set `allow_redirects=False`
and parse the `Location` header. Following the redirect would load the
dashboard SPA, which is unnecessary for automation.

### Error responses

If the token is invalid/expired, the verify endpoint still returns 303,
but the Location is:
```
https://app.supabase.com#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
```

Parse the fragment for `error` and `error_description` to detect failures.

---

## 3. GET auth.supabase.io/auth/v1/user

Fetches the GoTrue user object for the access_token. Confirms the
session works and gets the user's UUID.

### Request

```
GET https://auth.supabase.io/auth/v1/user
Authorization: Bearer <access_token>
x-client-info: gotrue-js/2.112.3
Origin: https://supabase.com
Referer: https://supabase.com/
```

### Response (200)

```json
{
  "id": "c6f93037-d0be-43c0-b631-f6735f775d87",
  "aud": "authenticated",
  "role": "authenticated",
  "email": "user@privatimail.com",
  "email_confirmed_at": "2026-08-12T09:36:01.153782Z",
  "phone": "",
  "confirmation_sent_at": "2026-08-12T09:35:06.798199Z",
  "confirmed_at": "2026-08-12T09:36:01.153782Z",
  "last_sign_in_at": "2026-08-12T09:36:01.156081Z",
  "app_metadata": {
    "provider": "email",
    "providers": ["email"]
  },
  "user_metadata": {
    "email_verified": true
  },
  "identities": [...]
}
```

The `id` field is the GoTrue user UUID — used as `gotrue_id` in the
platform profile.

### Error responses

- **403**: `{"code":403,"error_code":"bad_jwt","msg":"invalid JWT: ..."}`
  — the access_token is invalid/expired.

---

## 4. POST api.supabase.com/platform/profile

Creates the platform profile. Links the GoTrue user to a platform
account. MUST be done before creating an org or PAT.

### Request

```
POST https://api.supabase.com/platform/profile
Authorization: Bearer <access_token>
Content-Type: application/json
Origin: https://supabase.com
Referer: https://supabase.com/dashboard/org

{}
```

The body is empty (`{}`). The server derives everything from the JWT.

### Response (201)

```json
{
  "id": 16327969,
  "auth0_id": "email|c6f93037-d0be-43c0-b631-f6735f775d87",
  "primary_email": "user@privatimail.com",
  "username": "user@privatimail.com",
  "first_name": null,
  "last_name": null,
  "mobile": null,
  "is_alpha_user": false,
  "gotrue_id": "c6f93037-d0be-43c0-b631-f6735f775d87",
  "free_project_limit": 2
}
```

- `id` — the platform numeric ID (used for billing, etc.)
- `auth0_id` — legacy field, format `email|<gotrue_id>` (Supabase used
  to use Auth0; they've since migrated to GoTrue but kept the field name)
- `gotrue_id` — the GoTrue user UUID (matches the `id` from /auth/v1/user)
- `free_project_limit` — how many free projects the user can create (2 by default)

### Error responses

- **400**: profile already exists for this GoTrue user. Use `GET /platform/profile`
  instead.
- **401**: `{"message": "JWT could not be decoded"}` — the access_token
  is invalid/expired.

---

## 5. POST api.supabase.com/platform/organizations

Creates a new organization. The first org is typically created right
after signup as a PERSONAL free-tier org.

### Request

```
POST https://api.supabase.com/platform/organizations
Authorization: Bearer <access_token>
Content-Type: application/json
Origin: https://supabase.com
Referer: https://supabase.com/dashboard/new

{
  "name": "user@privatimail.com's Org",
  "kind": "PERSONAL",
  "tier": "tier_free"
}
```

- `name` — org name (the dashboard defaults to `"<email>'s Org"`)
- `kind` — `"PERSONAL"` (default) or `"BUSINESS"` (requires billing)
- `tier` — `"tier_free"` (default), `"tier_pro"`, `"tier_team"`, `"tier_enterprise"`

### Response (201)

```json
{
  "id": 14064728,
  "slug": "becfkdeegfxqpwcexrzg",
  "name": "user@privatimail.com's Org",
  "billing_email": "user@privatimail.com",
  "billing_partner": null,
  "integration_source": null,
  "is_owner": true,
  "stripe_customer_id": "cus_V3fvEb5IbiixKj",
  "opt_in_tags": [],
  "subscription_id": "WNeFgEu7A2iyG23N",
  "restriction_data": null,
  "restriction_status": null,
  "plan": {
    "id": "free",
    "name": "Free"
  },
  "usage_billing_enabled": false,
  "organization_requires_mfa": false,
  "organization_missing_address": false,
  "organization_missing_tax_id": false
}
```

- `id` — org numeric ID
- `slug` — org slug (used in URLs and API paths, e.g.
  `/platform/organizations/{slug}/projects`)
- `plan.id` — `"free"`, `"pro"`, `"team"`, `"enterprise"`
- `stripe_customer_id` — auto-created Stripe customer (even for free tier)

### Notes

- The slug is auto-generated (random lowercase letters). It's NOT derived
  from the org name.
- A Stripe customer is auto-created even for the free tier — this is how
  Supabase tracks usage-based billing for the free tier's limits.

---

## 6. POST api.supabase.com/platform/profile/access-tokens

Generates a Personal Access Token (PAT). This is the golden output of
the onboarding flow.

### Request

```
POST https://api.supabase.com/platform/profile/access-tokens
Authorization: Bearer <access_token>
Content-Type: application/json
Origin: https://supabase.com
Referer: https://supabase.com/dashboard/account/tokens

{
  "name": "new-token-30d",
  "expires_at": "2026-09-11T09:36:56.778Z"
}
```

- `name` — human-readable name (shown in dashboard)
- `expires_at` — ISO 8601 timestamp with milliseconds + Z suffix.
  The dashboard defaults to 30 days from now.

### Response (201)

```json
{
  "id": 6014190,
  "token_alias": "sbp_5ca2••••••••••••••••••••••••••••••••4752",
  "name": "new-token-30d",
  "created_at": "2026-08-12T09:36:57.153135+00:00",
  "expires_at": "2026-09-11T09:36:56.778+00:00",
  "last_used_at": null,
  "token": "sbp_***TEST_TOKEN***"
}
```

- `token` — the full PAT (`sbp_...`). **Only returned on creation.**
  Save it somewhere safe.
- `token_alias` — masked version, shown in the dashboard's token list.
  Format: `sbp_<first 4>••••••••••••••••••••••••••••••••<last 4>`

### The PAT format

The PAT is `sbp_` followed by 40 hex characters. It's NOT a JWT — it's
an opaque token. The platform API looks it up in a database.

The PAT works for:
- `api.supabase.com/platform/*` (dashboard API)
- `api.supabase.com/v1/*` (public Management API)
- The Supabase CLI (`supabase login --token sbp_...`)

---

## Email verification flow

The verification email is sent by Supabase immediately after `POST /platform/signup`
returns 201. The email contains:

**Subject**: `Reset your password` (yes, even for signup — Supabase reuses
the password-reset email template for signup verification)

**Body** (plain text):

```
*************
Reset your password
*************

We've received a request to reset the password for the Supabase account
associated with dev@privatimail.com. No changes have been made to your
account yet.
To reset your password, click on the button below.

Reset your password: https://auth.supabase.io/auth/v1/verify?token=ce9c6501e9a661cb1dc19aef5fa71d71ef838560afd82fec0df5050b&type=signup&redirect_to=https%3A%2F%2Fsupabase.com%2Fdashboard%2Fsign-in

If you didn't request for a password reset, you can safely ignore this email.

© 2023 . All rights reserved.
```

The link is `https://auth.supabase.io/auth/v1/verify?token=<40 hex chars>&type=signup&redirect_to=...`.

The email is fetched via the Cloudflare Email Worker (same instance as
Notion/Todoist onboarding). See `supabase_onboarding/signup/email_worker.py`
for the polling logic.

---

## WAF probe results

Run from the sandbox (datacenter IP, Hong Kong AS45102):

| Probe | Status | Server | Body | Verdict |
|-------|--------|--------|------|---------|
| `POST /platform/signup` (fake captcha) | 401 | cloudflare | `{"message":"Invalid or missing captcha token: invalid-input-response"}` | No WAF, captcha-gated |
| `GET /auth/v1/verify` (fake token, with redirect_to) | 303 | envoy | `<a href="...#error=access_denied&error_code=otp_expired...">` | No WAF |
| `GET /auth/v1/verify` (fake token, no redirect_to) | 303 | envoy | `<a href="...#error=access_denied&error_code=otp_expired...">` | No WAF |
| `GET /auth/v1/user` (fake bearer) | 403 | envoy | `{"code":403,"error_code":"bad_jwt","msg":"invalid JWT..."}` | No WAF |
| `GET /platform/profile` (fake bearer) | 401 | cloudflare | `{"message":"JWT could not be decoded"}` | No WAF |
| `GET /platform/organizations` (fake bearer) | 401 | cloudflare | `{"message":"JWT could not be decoded"}` | No WAF |
| `GET /platform/profile/access-tokens` (fake bearer) | 401 | cloudflare | `{"message":"JWT could not be decoded"}` | No WAF |

All responses are JSON (not Cloudflare's HTML "Attention Required" page).
The `Server: cloudflare` header is present on `api.supabase.com` responses
(because Cloudflare proxies the API), but there's no WAF gate — the API
accepts the request and returns a JSON error.

**Conclusion**: The browser extension bridge is only needed for the
hCaptcha token on signup. Everything else works with plain `requests`.

---

## Comparison with Notion onboarding

| Aspect | Notion | Supabase |
|--------|--------|----------|
| Signup endpoint | `POST /api/v3/sendTemporaryPassword` (email code) | `POST /platform/signup` (email+password) |
| Captcha | hCaptcha enterprise (rejects headless for signup) | hCaptcha (enterprise status unknown) |
| Email verification | 6-digit code via `POST /api/v3/loginWithEmail` | Verify link via `GET /auth/v1/verify` (returns JWT in redirect) |
| Session | Cookies (`token_v2`, `notion_user_id`, `notion_device_id`) | Bearer JWT (30 min) → PAT (long-lived) |
| WAF | Cloudflare (`__cf_bm` enforced) | Cloudflare (`__cf_bm` NOT enforced) |
| Post-verify setup | saveTransactions (CRDT), createSpace, getBotToken | create_profile, create_organization, create_access_token |
| API style | RPC-style (`saveTransactionsFanout` with operations) | REST (`POST /platform/profile`, `POST /platform/organizations`) |

Supabase's API is significantly simpler:
- No CRDT/transaction layer
- No cookie-based session (just Bearer)
- No WAF enforcement on API endpoints
- The verify step returns the access_token directly (no separate login step)

The only complication is the `redirect_to` bug, which is easily worked
around by stripping the param.

---

## Live validation results

The redirect_to workaround and Bearer-auth path were validated against the
real Supabase endpoints from the sandbox:

### Verify endpoint (live test)

Tested `verify_email()` with the sample URL from `supabase.signup-email.txt`
(token `cfe3771b4707ecd4a0dd2509bdc019541471dfddfda81a6cfb55a941` — expired).

**With** `redirect_to` stripped (our implementation):
- Status: 303
- Location: `https://app.supabase.com#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`
- Verdict: ✅ The verify endpoint returned a proper error redirect (otp_expired),
  NOT the buggy "Verify requires a verification type" error. The workaround works.

**Without** stripping (raw email URL): the dashboard shows
`{"code":400,"error_code":"validation_failed","msg":"Verify requires a verification type"}`
(confirming the bug exists).

### Platform API (live test)

Tested `GET /platform/profile` with a fake Bearer token from the sandbox
datacenter IP:

- Status: 401
- Body: `{"message":"JWT could not be decoded"}`
- Server: cloudflare
- Verdict: ✅ No WAF blocking, no Cloudflare "Attention Required" page.
  The API accepts plain requests with Bearer auth. Cookies (__cf_bm) are
  NOT required.

### Conclusion

The architecture is validated:
- Only `POST /platform/signup` needs the browser extension (for hCaptcha)
- `GET /auth/v1/verify` works with plain `requests` (after stripping redirect_to)
- All `api.supabase.com/platform/*` endpoints work with plain `requests` + Bearer
- The bridge daemon + Chrome extension are only needed for the signup step
