/**
 * Supabase Automation Module — onboarding flows.
 *
 * Architecture:
 * - Steps 2-7 (email poll, verify, profile, org, PAT) use DIRECT fetch()
 *   from the worker. Supabase has NO WAF on these endpoints — confirmed
 *   via live probing from a datacenter IP.
 * - Step 1 (signup) requires hCaptcha, so it goes through the extension
 *   via BridgeHub.sendCommand() (tabs.open, form.fill, form.click).
 *
 * The email worker (mail-api.privatimail.com) is called directly — no WAF.
 */

import type { BridgeHub } from './bridge-hub';

// The hub is accessed via DurableObjectNamespace.fetch() — we use a minimal
// interface that matches what SupabaseAutomation needs.
interface HubLike {
    sendCommand(cmd: any, timeoutMs?: number): Promise<any>;
    fetchViaExtension(url: string, options?: any): Promise<any>;
}

const SUPABASE_API = 'https://api.supabase.com';
const SUPABASE_AUTH = 'https://auth.supabase.io/auth/v1';
const VERIFY_LINK_RE = /https:\/\/auth\.supabase\.io\/auth\/v1\/verify\?[^\s"'<>]+/;

function platformHeaders(accessToken: string): Record<string, string> {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://supabase.com',
        'Referer': 'https://supabase.com/dashboard',
    };
}

export interface OnboardResult {
    email: string;
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    expiresIn: number;
    profileId: number;
    gotrueId: string;
    orgId: number;
    orgSlug: string;
    orgName: string;
    planId: string;
    pat: string;
    patId: number;
    patAlias: string;
    patExpiresAt: string;
    freeProjectLimit: number;
}

export class SupabaseAutomation {
    constructor(private hub: HubLike, private env: any) {}

    // --- 1. Signup via extension (hCaptcha required) ---
    //
    // The extension opens the signup page, fills the form, and waits for
    // the user to solve the hCaptcha. After the user solves it, the form
    // auto-submits. The worker detects success by polling the email worker
    // for the verification email (which only arrives if signup succeeded).

    async signupViaExtension(email: string, password: string, captchaTimeoutSec: number = 300): Promise<void> {
        // Step 1a: Open the signup page
        await this.hub.sendCommand({
            type: 'tabs.open',
            url: 'https://supabase.com/dashboard/sign-up',
            active: true,
        }, 60000);

        // Wait for page to load
        await new Promise(r => setTimeout(r, 4000));

        // Step 1b: Fill the form using extension's form.fill
        // The email field is input#email (type="text"), password is input#password
        await this.hub.sendCommand({
            type: 'form.fill',
            selector: '#email',
            value: email,
        }, 10000);

        await this.hub.sendCommand({
            type: 'form.fill',
            selector: '#password',
            value: password,
        }, 10000);

        // Step 1c: Click Sign Up button
        await this.hub.sendCommand({
            type: 'form.click',
            selector: 'button[type="submit"]',
        }, 10000);

        // The hCaptcha challenge now appears in the browser.
        // The user solves it manually. After solving, the form auto-submits.
        // We detect success by polling the email worker (step 2).
        // No need to wait here — the caller polls for the verify email.
    }

    // --- 2. Poll email worker for verification link ---

    async waitForVerifyEmail(email: string, timeoutSec: number = 180): Promise<{ url: string; token: string }> {
        const workerUrl = (this.env.EMAIL_WORKER_URL || 'https://mail-api.privatimail.com').replace(/\/$/, '');
        const deadline = Date.now() + timeoutSec * 1000;

        while (Date.now() < deadline) {
            const url = `${workerUrl}/emails?address=${encodeURIComponent(email)}&limit=10&include_body=true`;
            const r = await fetch(url, {
                headers: { 'Authorization': `Bearer ${this.env.EMAIL_WORKER_TOKEN}` },
            });
            if (r.ok) {
                const data: any = await r.json();
                for (const em of data.results || []) {
                    const body = ((em.text_body || '') + '\n' + (em.html_body || '')).replace(/&amp;/g, '&');
                    const m = VERIFY_LINK_RE.exec(body);
                    if (m) {
                        const link = m[0].replace(/[.,);]+$/, '');
                        // Parse token from the URL
                        const urlObj = new URL(link);
                        const token = urlObj.searchParams.get('token') || '';
                        return { url: link, token };
                    }
                }
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        throw new Error(`No verification email for ${email} within ${timeoutSec}s`);
    }

    // --- 3. Follow verify link (strip redirect_to bug workaround) ---

    async verifyEmail(verifyUrl: string): Promise<{
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        expiresIn: number;
    }> {
        // Strip redirect_to (Supabase bug: it causes "Verify requires a verification type")
        const url = new URL(verifyUrl);
        const token = url.searchParams.get('token') || '';
        const type = url.searchParams.get('type') || 'signup';
        url.searchParams.delete('redirect_to');
        const cleanUrl = `${url.origin}${url.pathname}?token=${token}&type=${type}`;

        // Follow the redirect manually (don't auto-redirect)
        const r = await fetch(cleanUrl, {
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        });

        if (r.status !== 303) {
            throw new Error(`Verify returned ${r.status}, expected 303`);
        }

        const location = r.headers.get('Location') || '';
        if (!location.includes('#')) {
            // Check for error redirect
            if (location.includes('error=')) {
                const errUrl = new URL(location);
                const errDesc = errUrl.searchParams.get('error_description') || 'unknown error';
                throw new Error(`Verify failed: ${errDesc}`);
            }
            throw new Error(`Verify redirect has no fragment: ${location.slice(0, 200)}`);
        }

        // Parse the fragment: #access_token=...&refresh_token=...&expires_in=...
        const fragment = location.split('#')[1];
        const params = new URLSearchParams(fragment);
        const accessToken = params.get('access_token') || '';
        if (!accessToken) {
            throw new Error(`No access_token in verify redirect: ${fragment.slice(0, 200)}`);
        }

        return {
            accessToken,
            refreshToken: params.get('refresh_token') || '',
            expiresAt: parseInt(params.get('expires_at') || '0', 10),
            expiresIn: parseInt(params.get('expires_in') || '0', 10),
        };
    }

    // --- 4. Get user ---

    async getUser(accessToken: string): Promise<any> {
        const r = await fetch(`${SUPABASE_AUTH}/user`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'x-client-info': 'gotrue-js/2.112.3',
                'Origin': 'https://supabase.com',
            },
        });
        if (!r.ok) throw new Error(`GET /auth/v1/user failed: ${r.status}`);
        return r.json();
    }

    // --- 5. Create platform profile ---

    async createProfile(accessToken: string): Promise<any> {
        // First check if profile exists
        const getR = await fetch(`${SUPABASE_API}/platform/profile`, {
            headers: platformHeaders(accessToken),
        });
        if (getR.ok) {
            return getR.json();
        }
        // Create if not found (404)
        const r = await fetch(`${SUPABASE_API}/platform/profile`, {
            method: 'POST',
            headers: platformHeaders(accessToken),
            body: '{}',
        });
        if (!r.ok) throw new Error(`POST /platform/profile failed: ${r.status} ${await r.text()}`);
        return r.json();
    }

    // --- 6. Create organization ---

    async createOrganization(accessToken: string, name: string): Promise<any> {
        // First check if org exists
        const listR = await fetch(`${SUPABASE_API}/platform/organizations`, {
            headers: platformHeaders(accessToken),
        });
        if (listR.ok) {
            const orgs = await listR.json();
            if (Array.isArray(orgs) && orgs.length > 0) {
                return orgs[0]; // return existing org
            }
        }
        // Create new org
        const r = await fetch(`${SUPABASE_API}/platform/organizations`, {
            method: 'POST',
            headers: platformHeaders(accessToken),
            body: JSON.stringify({ name, kind: 'PERSONAL', tier: 'tier_free' }),
        });
        if (!r.ok) throw new Error(`POST /platform/organizations failed: ${r.status} ${await r.text()}`);
        return r.json();
    }

    // --- 7. Generate PAT ---

    async createPAT(accessToken: string, name: string, expiresAt: Date): Promise<any> {
        const expiresStr = expiresAt.toISOString().replace(/\.\d+Z$/, '.') +
            String(expiresAt.getMilliseconds()).padStart(3, '0') + 'Z';
        const r = await fetch(`${SUPABASE_API}/platform/profile/access-tokens`, {
            method: 'POST',
            headers: platformHeaders(accessToken),
            body: JSON.stringify({ name, expires_at: expiresStr }),
        });
        if (!r.ok) throw new Error(`POST /platform/profile/access-tokens failed: ${r.status} ${await r.text()}`);
        return r.json();
    }

    // --- Full pipeline ---

    async runFullPipeline(email: string, password: string, options: {
        orgName?: string;
        patName?: string;
        patExpiresInDays?: number;
    } = {}): Promise<OnboardResult> {
        const orgName = options.orgName || `${email}'s Org`;
        const patName = options.patName || 'automation-token';
        const patExpiresInDays = options.patExpiresInDays || 30;

        // Step 1: Signup via extension (hCaptcha)
        await this.signupViaExtension(email, password);

        // Step 2: Poll for verify email
        const { url: verifyUrl } = await this.waitForVerifyEmail(email, 300);

        // Step 3: Follow verify link
        const tokens = await this.verifyEmail(verifyUrl);

        // Step 4: Get user
        const user = await this.getUser(tokens.accessToken);

        // Step 5: Create profile
        const profile = await this.createProfile(tokens.accessToken);

        // Step 6: Create org
        const org = await this.createOrganization(tokens.accessToken, orgName);

        // Step 7: Generate PAT
        const expiresAt = new Date(Date.now() + patExpiresInDays * 86400000);
        const pat = await this.createPAT(tokens.accessToken, patName, expiresAt);

        return {
            email: user.email || email,
            userId: user.id,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            expiresIn: tokens.expiresIn,
            profileId: profile.id,
            gotrueId: profile.gotrue_id,
            orgId: org.id,
            orgSlug: org.slug,
            orgName: org.name,
            planId: org.plan?.id || 'free',
            pat: pat.token,
            patId: pat.id,
            patAlias: pat.token_alias,
            patExpiresAt: pat.expires_at,
            freeProjectLimit: profile.free_project_limit || 2,
        };
    }

    // --- Re-login flow: send password reset email + capture temp credentials ---

    async relogin(email: string): Promise<{ resetLink: string | null; note: string }> {
        // Supabase's password recovery endpoint also requires hCaptcha.
        // We route it through the extension's browser context.
        try {
            const result = await this.hub.fetchViaExtension(
                `${SUPABASE_AUTH}/recover`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-client-info': 'gotrue-js/2.112.3',
                    },
                    body: JSON.stringify({ email }),
                    credentials: 'omit',
                    timeoutMs: 15000,
                }
            );
            if (result.ok) {
                // Now poll for the reset email
                const { url } = await this.waitForVerifyEmail(email, 120);
                return {
                    resetLink: url,
                    note: 'Password reset email sent. Click the link to set a new password. The link expires in 10 minutes.',
                };
            }
            return { resetLink: null, note: `Recovery request failed: ${result.status} ${result.body}` };
        } catch (err) {
            return { resetLink: null, note: `Recovery failed: ${(err as Error).message}` };
        }
    }

    // --- Verify a PAT works against /v1/* Management API ---

    async verifyPAT(pat: string): Promise<boolean> {
        const r = await fetch(`${SUPABASE_API}/v1/organizations`, {
            headers: { 'Authorization': `Bearer ${pat}` },
        });
        return r.ok;
    }

    // --- JWT refresh (for long-lived /platform/* access) ---
    //
    // The JWT from verify expires in 30 min. The refresh_token (also from verify)
    // can be used to get a fresh JWT. The refresh_token ROTATES on each refresh.

    async refreshJWT(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        expiresIn: number;
    }> {
        const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1cGFidGFzZSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNjQ1NzI4MDAwLCJleHAiOjIwMDAwMDAwMDB9.XQQwMjyZmhQOjG3iG8pT';
        const r = await fetch(`${SUPABASE_AUTH}/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ANON_KEY}`,
                'x-client-info': 'gotrue-js/2.112.3',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!r.ok) {
            throw new Error(`JWT refresh failed: ${r.status} ${await r.text()}`);
        }
        const data: any = await r.json();
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: data.expires_at,
            expiresIn: data.expires_in,
        };
    }

    // --- /platform/* endpoints (require JWT, not PAT) ---
    //
    // These are undocumented dashboard endpoints discovered via live probing.
    // They require the JWT (from verify/refresh), NOT the PAT.

    async platformGet(accessToken: string, path: string): Promise<any> {
        const r = await fetch(`${SUPABASE_API}${path}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Origin': 'https://supabase.com',
                'Referer': 'https://supabase.com/dashboard',
            },
        });
        if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
        return r.json();
    }

    async platformPatch(accessToken: string, path: string, body: any): Promise<any> {
        const r = await fetch(`${SUPABASE_API}${path}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Origin': 'https://supabase.com',
                'Referer': 'https://supabase.com/dashboard',
            },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`PATCH ${path} failed: ${r.status} ${await r.text()}`);
        return r.json();
    }

    async platformDelete(accessToken: string, path: string): Promise<any> {
        const r = await fetch(`${SUPABASE_API}${path}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Origin': 'https://supabase.com',
                'Referer': 'https://supabase.com/dashboard',
            },
        });
        if (!r.ok) throw new Error(`DELETE ${path} failed: ${r.status} ${await r.text()}`);
        return r.json().catch(() => null);
    }

    // Billing (read-only)
    async getBillingSubscription(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformGet(accessToken, `/platform/organizations/${orgSlug}/billing/subscription`);
    }

    async getBillingPlans(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformGet(accessToken, `/platform/organizations/${orgSlug}/billing/plans`);
    }

    async getInvoices(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformGet(accessToken, `/platform/organizations/${orgSlug}/billing/invoices`);
    }

    async getUpcomingInvoice(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformGet(accessToken, `/platform/organizations/${orgSlug}/billing/invoices/upcoming`);
    }

    async getOrgUsage(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformGet(accessToken, `/platform/organizations/${orgSlug}/usage`);
    }

    // Organization management
    async renameOrg(accessToken: string, orgSlug: string, newName: string): Promise<any> {
        return this.platformPatch(accessToken, `/platform/organizations/${orgSlug}`, { name: newName });
    }

    async deleteOrg(accessToken: string, orgSlug: string): Promise<any> {
        return this.platformDelete(accessToken, `/platform/organizations/${orgSlug}`);
    }

    // Profile management
    async updateProfile(accessToken: string, fields: { first_name?: string; last_name?: string; mobile?: string }): Promise<any> {
        return this.platformPatch(accessToken, '/platform/profile', fields);
    }

    async getProfile(accessToken: string): Promise<any> {
        return this.platformGet(accessToken, '/platform/profile');
    }

    async getPermissions(accessToken: string): Promise<any> {
        return this.platformGet(accessToken, '/platform/profile/permissions');
    }

    // PAT lifecycle (JWT-authenticated, separate from the PAT itself)
    async listPATs(accessToken: string): Promise<any[]> {
        const r = await fetch(`${SUPABASE_API}/platform/profile/access-tokens`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Origin': 'https://supabase.com',
            },
        });
        if (!r.ok) throw new Error(`List PATs failed: ${r.status}`);
        return r.json();
    }

    async deletePAT(accessToken: string, patId: number): Promise<any> {
        return this.platformDelete(accessToken, `/platform/profile/access-tokens/${patId}`);
    }

    // --- Health check ---
    //
    // Checks the standing of an account: PAT validity, JWT validity,
    // account standing (banned/disabled?), project status, org status.
    // Returns a structured report.

    async checkHealth(pat: string, accessToken?: string, refreshToken?: string): Promise<{
        pat_valid: boolean;
        jwt_valid: boolean;
        jwt_refreshed: boolean;
        account_standing: string;  // 'good' | 'banned' | 'disabled' | 'unknown'
        profile: any | null;
        organizations: any[];
        projects: any[];
        errors: string[];
    }> {
        const errors: string[] = [];
        let pat_valid = false;
        let jwt_valid = false;
        let jwt_refreshed = false;
        let account_standing = 'unknown';
        let profile: any = null;
        let organizations: any[] = [];
        let projects: any[] = [];

        // 1. Check PAT validity (GET /v1/organizations)
        try {
            const r = await fetch(`${SUPABASE_API}/v1/organizations`, {
                headers: { 'Authorization': `Bearer ${pat}` },
            });
            if (r.ok) {
                pat_valid = true;
                organizations = await r.json();
            } else if (r.status === 401) {
                errors.push('PAT invalid or revoked');
            } else {
                errors.push(`PAT check returned ${r.status}`);
            }
        } catch (e) {
            errors.push(`PAT check error: ${(e as Error).message}`);
        }

        // 2. Check JWT validity (GET /platform/profile)
        if (accessToken) {
            try {
                const r = await fetch(`${SUPABASE_API}/platform/profile`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Origin': 'https://supabase.com',
                    },
                });
                if (r.ok) {
                    jwt_valid = true;
                    profile = await r.json();
                    // Check account standing from profile
                    if (profile.disabled_features && profile.disabled_features.length > 0) {
                        account_standing = 'disabled';
                    } else {
                        account_standing = 'good';
                    }
                } else if (r.status === 401 && refreshToken) {
                    // Try refreshing the JWT
                    try {
                        const newTokens = await this.refreshJWT(refreshToken);
                        jwt_refreshed = true;
                        // Retry with new JWT
                        const r2 = await fetch(`${SUPABASE_API}/platform/profile`, {
                            headers: {
                                'Authorization': `Bearer ${newTokens.accessToken}`,
                                'Origin': 'https://supabase.com',
                            },
                        });
                        if (r2.ok) {
                            jwt_valid = true;
                            profile = await r2.json();
                            account_standing = (profile.disabled_features && profile.disabled_features.length > 0) ? 'disabled' : 'good';
                        } else {
                            errors.push(`JWT refresh succeeded but profile fetch failed: ${r2.status}`);
                        }
                    } catch (refreshErr) {
                        errors.push(`JWT refresh failed: ${(refreshErr as Error).message}`);
                    }
                } else if (r.status === 401) {
                    errors.push('JWT expired and no refresh token');
                } else {
                    errors.push(`JWT check returned ${r.status}`);
                }
            } catch (e) {
                errors.push(`JWT check error: ${(e as Error).message}`);
            }
        }

        // 3. List projects (via PAT if valid)
        if (pat_valid) {
            try {
                const r = await fetch(`${SUPABASE_API}/v1/projects`, {
                    headers: { 'Authorization': `Bearer ${pat}` },
                });
                if (r.ok) {
                    projects = await r.json();
                }
            } catch (e) {
                errors.push(`Project list error: ${(e as Error).message}`);
            }
        }

        return {
            pat_valid,
            jwt_valid,
            jwt_refreshed,
            account_standing,
            profile,
            organizations,
            projects,
            errors,
        };
    }
}
