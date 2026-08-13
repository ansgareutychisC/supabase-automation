# Billing/Account/Org Automation — Research + Dashboard Exploration

## Part 1: What's Worth Automating

### Critical finding: Stripe API is NOT an alternative

The Stripe account that processes Supabase subscriptions belongs to **Supabase, not the user**. Users are *customers* in Supabase's Stripe account. Supabase does NOT expose the Stripe customer ID via any API. Therefore:
- We cannot query Stripe directly for invoices, payment methods, or subscription status
- **Browser automation is the only option** for billing operations
- Alternative for invoice data: parse invoice emails sent to the billing address

### Top 5 operations worth automating via browser

| Priority | Operation | Why | Difficulty |
|----------|-----------|-----|------------|
| 🥇 1 | **Add payment method** (credit card) | Every new paid org needs a card; cards expire; bulk fleet provisioning. Likely Stripe Elements iframe (PCI). | Hard (iframe) |
| 🥈 2 | **Upgrade plan** (Free → Pro → Team) | Core fleet-provisioning step; pairs with payment method. Skip Enterprise (form-based). | Medium |
| 🥉 3 | **Toggle Spend Cap** | Per-org decision: ON for test/staging (cost protection), OFF for production (allow scale). Simple toggle. | Easy |
| 4 | **Delete organization** | Fleet cleanup of test/staging orgs. Deletes all child projects. No API. Historically buggy (#28848). | Medium |
| 5 | **PAT lifecycle management** (list/delete old) | CLI creates a new PAT on every `supabase login` → token clutter. Rotation is security best practice. | Easy |

*(Honorable mention: billing address + Tax ID setup during onboarding — must be done before first invoice, newly relevant with 2026 tax collection.)*

### Operations better handled via API (skip browser)

| Operation | API endpoint |
|-----------|-------------|
| Org creation | `POST /v1/organizations` |
| Project create/delete/pause/restore/transfer | `/v1/projects/*` |
| Member invites + role management | `/v1/organizations/{slug}/members` |
| Project add-ons (compute, IPv4, log drains) | `/v1/projects/{ref}/addons` |
| Project cycling (bypass 2-free limit) | `POST /v1/projects/{ref}/pause` + `/restore` |

### Operations NOT worth automating

| Operation | Why skip |
|-----------|----------|
| Change password (logged in) | Redundant — existing password-reset-via-email flow works |
| Rename organization | Rare, cosmetic, one-time |
| Enable 2FA | One-time; complicates future dashboard logins; PATs keep working without it |
| Enterprise plan upgrade | Requires form submission / sales contact, not self-serve |
| Member invites | Fully API-supported |
| Project pause/restore/transfer | Fully API-supported |

### Recommended hybrid architecture

```
API-only (no browser):
  - Org creation, project CRUD, pause/restore, transfer
  - Member invites + roles
  - Project add-ons, API keys, signing keys
  - All auth config (providers, MFA, hooks, templates)

Browser automation (no API exists):
  - Signup + hCaptcha (done ✅)
  - Payment method, plan upgrade/downgrade
  - Spend cap toggle, billing address + tax ID
  - Org deletion, PAT list/delete
  - Account deletion, invoice download

Email-based (alternative to browser):
  - Parse invoice emails for accounting automation
  - Less fragile than PDF scraping
```

---

## Part 2: Login via Agent-Browser — Attempted + Failed

### What happened

Tried to log in to the Supabase dashboard via `agent-browser` (headless Chrome 151) using the test account `supa-e2e-7@privatimail.com`:

1. Opened `https://supabase.com/dashboard/sign-in`
2. Filled email + password
3. Clicked "Sign in"
4. **hCaptcha visual challenge appeared**: "Choose the one that does not follow the circular sequence" (page 1 of 2)

### Key finding

**Login requires a visual hCaptcha challenge — it does NOT auto-pass for existing accounts.**

This is different from Notion, where hCaptcha enterprise mode allows headless login (only blocks signup). Supabase's hCaptcha shows a visual challenge for BOTH signup AND login.

**Screenshot saved**: `download/supabase-login-hcaptcha.png`

### Implications

1. **Cannot study dashboard UX via agent-browser** — login is blocked by captcha
2. **Cannot automate login** without a captcha-solving service (2captcha, anti-captcha)
3. **The existing extension-based session** is the only way to explore the dashboard
4. **Session expired** — the localStorage auth tokens were cleared during the E2E test

### To explore the dashboard UX

We need one of:
1. **User logs in again** in their Chrome browser → I can use the extension to navigate billing/org/account pages and capture the UX
2. **Captcha-solving service** integrated with agent-browser → can automate login + explore
3. **Manual HAR capture** by the user → I analyze the HAR files

---

## Part 3: Dashboard Exploration via Extension — Session Expired

Tried to open `https://supabase.com/dashboard/org/billing` via the connected extension. The page redirected to `/sign-in?returnTo=%2Forg%2Fbilling` — the session in the user's browser has expired (we cleared localStorage during the E2E signup test).

**Current state**: No active Supabase session in the browser. To study the billing/org/account UX paths, the user needs to log in again.

### Next steps for dashboard exploration

1. **User logs in** to `supabase.com/dashboard` in their Chrome browser (solve the captcha manually)
2. **I use the extension** to navigate to:
   - `/dashboard/org/billing` — payment methods, plan, spend cap, invoices
   - `/dashboard/org/{slug}/settings` — org rename, delete, billing email
   - `/dashboard/account/tokens` — PAT management
   - `/dashboard/account/general` — account settings
3. **Capture the DOM structure + API calls** for each page
4. **Document the automation flow** for each priority operation

---

## Summary

| Question | Answer |
|----------|--------|
| Is `sbp_...` PAT sufficient? | ✅ Yes — for all Management API (`/v1/*`) operations |
| Can we use Stripe API for billing? | ❌ No — Stripe belongs to Supabase, customer ID not exposed |
| Can we log in via agent-browser? | ❌ No — hCaptcha visual challenge blocks login |
| What billing ops are worth automating? | Payment method, plan upgrade, spend cap, org deletion, PAT lifecycle |
| What's the easiest high-value automation? | **Spend cap toggle** (simple toggle, no iframe) |
| What's the hardest? | **Payment method** (Stripe Elements iframe, PCI compliance) |
| Can we study the dashboard UX now? | ❌ Session expired — need user to log in again |

## Recommended next actions

1. **Prototype spend-cap toggle** — easiest high-value browser automation
2. **Prototype PAT list/delete** — addresses documented CLI clutter pain point
3. **Validate payment-method iframe** — confirm if Stripe Elements or Supabase-hosted form
4. **Set up invoice-email parsing** — lower-friction alternative to browser-based invoice download
5. **Decide on 2FA policy** — recommend NOT enabling 2FA on automation accounts (PATs still work, but dashboard re-login becomes harder)
6. **For dashboard UX study** — user logs in again, then I explore via extension

## Sources

### Billing/org research
- https://supabase.com/docs/guides/platform/billing-on-supabase
- https://supabase.com/docs/guides/platform/manage-your-subscription
- https://supabase.com/docs/guides/platform/access-control
- https://supabase.com/pricing
- https://github.com/supabase/supabase/issues/28848 (org deletion bug)
- https://github.com/orgs/supabase/discussions/32609 (change plan programmatically)

### Login captcha finding
- Live test via agent-browser (Chrome 151, headless)
- Screenshot: `download/supabase-login-hcaptcha.png`
- Confirmed: hCaptcha visual challenge for login (not just signup)
