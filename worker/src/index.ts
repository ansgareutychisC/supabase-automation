/**
 * Supabase Onboarding Worker — main entry point.
 *
 * Architecture:
 *   Hono app (HTTP routes) → BridgeHub DO (extension WebSocket + command proxy)
 *   D1 (account/org/job state)
 *   SupabaseAutomation module (signup via extension, steps 2-7 direct fetch)
 *
 * The worker is the "fleet manager" — it orchestrates account creation,
 * verification, profile/org setup, and PAT generation. The signup step
 * (hCaptcha) is routed through the Chrome extension via BridgeHub.
 * Steps 2-7 use direct fetch() — Supabase has no WAF on these endpoints.
 *
 * Routes:
 *   GET  /                      — Dashboard HTML UI
 *   GET  /health                — Liveness probe
 *   GET  /api/token             — Bridge auth token (for extension)
 *   GET  /api/extensions        — Extension connection status
 *   GET  /api/accounts          — List all accounts
 *   GET  /api/accounts/:id      — Single account by email
 *   POST /api/accounts/import   — Import existing account
 *   POST /api/accounts/export   — Export all accounts as JSON
 *   DELETE /api/accounts/:id    — Delete account
 *   POST /api/accounts/:id/relogin — Re-login flow (password reset)
 *   GET  /api/jobs              — List jobs
 *   POST /api/run               — Run full pipeline (async)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BridgeHub, type Env } from './bridge-hub';
import { SupabaseAutomation } from './supabase';
import { dashboardHTML } from './dashboard';

export { BridgeHub };

const app = new Hono<{ Bindings: Env }>();

// --- Middleware ---
app.use('*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'x-request-id'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// Auth middleware (skip /health, /, /api/token, /ws)
app.use('/api/*', async (c, next) => {
    if (c.env.BRIDGE_NO_AUTH === '1') return next();
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${c.env.BRIDGE_TOKEN}`) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
});

// --- Health ---
app.get('/health', (c) => c.json({ ok: true, service: 'supabase-onboarding-worker', time: Date.now() }));

// --- Token bootstrap (for extension) ---
app.get('/api/token', (c) => c.json({ token: c.env.BRIDGE_TOKEN || '' }));

// Helper: get the BridgeHub DO stub (singleton instance named "default")
function getHub(c: any): DurableObjectStub {
    const ns = c.env.BRIDGE_HUB as DurableObjectNamespace;
    const id = ns.idFromName('default');
    return ns.get(id);
}

// Helper: log an event to D1 event_logs table
async function logEvent(db: D1Database, email: string, eventType: string, severity: string, message: string, details?: any) {
    try {
        await db.prepare(
            'INSERT INTO event_logs (account_email, event_type, severity, message, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(email, eventType, severity, message, details ? JSON.stringify(details) : null, Date.now()).run();
    } catch (e) {
        console.error('Failed to log event:', e);
    }
}

// --- Extension status ---
app.get('/api/extensions', async (c) => {
    const hub = getHub(c);
    const res = await hub.fetch(new Request('https://do/status'));
    return res;
});

// --- Accounts ---
app.get('/api/accounts', async (c) => {
    const db = c.env.DB as D1Database;
    const results = await db.prepare(
        'SELECT email, user_id, profile_id, org_slug, org_name, plan_id, pat_alias, pat_name, pat_expires_at, status, created_at, updated_at FROM accounts ORDER BY created_at DESC LIMIT 200'
    ).all();
    return c.json({ accounts: results.results });
});

app.get('/api/accounts/:id', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    // Look up by email or user_id
    const result = await db.prepare(
        'SELECT * FROM accounts WHERE email = ? OR user_id = ?'
    ).bind(id, id).first();
    if (!result) return c.json({ error: 'Not found' }, 404);
    // Don't return the full PAT in the list view — only on explicit request
    return c.json({ account: result });
});

// Show full PAT for an account
app.get('/api/accounts/:id/pat', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const result = await db.prepare(
        'SELECT email, pat, pat_alias, pat_expires_at FROM accounts WHERE email = ? OR user_id = ?'
    ).bind(id, id).first();
    if (!result) return c.json({ error: 'Not found' }, 404);
    return c.json({ account: result });
});

// --- Import account ---
app.post('/api/accounts/import', async (c) => {
    const db = c.env.DB as D1Database;
    const body = await c.req.json();
    const now = Date.now();

    await db.prepare(`
        INSERT INTO accounts (
            email, password, user_id, profile_id, access_token, refresh_token,
            token_expires_at, pat, pat_id, pat_name, pat_alias, pat_expires_at,
            org_id, org_slug, org_name, plan_id, cookies, session_data,
            status, onboarding_report, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            password = COALESCE(excluded.password, password),
            pat = COALESCE(excluded.pat, pat),
            user_id = COALESCE(excluded.user_id, user_id),
            updated_at = excluded.updated_at
    `).bind(
        body.email, body.password || '', body.user_id || null, body.profile_id || null,
        body.access_token || null, body.refresh_token || null, body.token_expires_at || null,
        body.pat || null, body.pat_id || null, body.pat_name || null, body.pat_alias || null, body.pat_expires_at || null,
        body.org_id || null, body.org_slug || null, body.org_name || null, body.plan_id || 'free',
        body.cookies || null, body.session_data || null,
        body.status || 'imported', body.onboarding_report || '{}', now, now
    ).run();

    return c.json({ ok: true, email: body.email });
});

// --- Export all accounts ---
app.post('/api/accounts/export', async (c) => {
    const db = c.env.DB as D1Database;
    const results = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    return c.json({
        exported_at: Date.now(),
        count: results.results.length,
        accounts: results.results,
    });
});

// --- Delete account ---
app.delete('/api/accounts/:id', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    await db.prepare('DELETE FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).run();
    return c.json({ ok: true });
});

// --- Re-login flow ---
app.post('/api/accounts/:id/relogin', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const account = await db.prepare('SELECT email FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).first() as any;
    if (!account) return c.json({ error: 'Not found' }, 404);

    const hub = getHub(c);
    const supa = new SupabaseAutomation(hub as any, c.env);

    try {
        const result = await supa.relogin(account.email);
        await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
            .bind('relogin_sent', Date.now(), account.email).run();
        return c.json({ ok: true, email: account.email, ...result });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 500);
    }
});

// --- Jobs ---
app.get('/api/jobs', async (c) => {
    const db = c.env.DB as D1Database;
    const results = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50').all();
    return c.json({ jobs: results.results });
});

// --- Full pipeline: signup → verify → profile → org → PAT ---
app.post('/api/run', async (c) => {
    const body = await c.req.json();
    const email = body.email || `auto_${Date.now()}@${c.env.EMAIL_DOMAIN || 'privatimail.com'}`;
    const password = body.password || generatePassword();
    const orgName = body.orgName || `${email}'s Org`;
    const patName = body.patName || 'automation-token';
    const patExpiresInDays = body.patExpiresInDays || 30;

    const db = c.env.DB as D1Database;
    const hub = getHub(c);
    const supa = new SupabaseAutomation(hub as any, c.env);

    const jobId = crypto.randomUUID();
    const now = Date.now();

    // Insert job record + account record
    await db.prepare('INSERT INTO jobs (id, account_email, stage, status, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(jobId, email, 'full', 'running', JSON.stringify(body), now, now).run();
    await db.prepare('INSERT OR IGNORE INTO accounts (email, password, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(email, password, 'created', now, now).run();

    // Run pipeline asynchronously
    c.executionCtx.waitUntil((async () => {
        const steps: any[] = [];
        await logEvent(db, email, 'pipeline_started', 'info', `Pipeline started for ${email}`, { jobId, password });
        try {
            // Step 1: Signup via extension (hCaptcha)
            steps.push({ step: 'signup', status: 'running' });
            await logEvent(db, email, 'signup_started', 'info', 'Signup via extension (hCaptcha)');
            try {
                await supa.signupViaExtension(email, password);
                await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                    .bind('signed_up', Date.now(), email).run();
                steps[0].status = 'completed';
                steps[0].note = 'hCaptcha solved by user in browser';
                await logEvent(db, email, 'signup_completed', 'info', 'Signup succeeded (201)');
            } catch (e) {
                steps[0].status = 'failed';
                steps[0].error = (e as Error).message;
                await logEvent(db, email, 'signup_failed', 'error', `Signup failed: ${(e as Error).message}`, { error: (e as Error).stack });
                throw e;
            }

            // Step 2: Poll for verify email
            steps.push({ step: 'verify_email', status: 'running' });
            await logEvent(db, email, 'verify_email_waiting', 'info', 'Waiting for verification email');
            try {
                const { url: verifyUrl } = await supa.waitForVerifyEmail(email, 300);
                steps[1].status = 'completed';
                steps[1].verifyUrl = verifyUrl.slice(0, 80) + '...';
                await logEvent(db, email, 'verify_email_received', 'info', 'Verification email received');
            } catch (e) {
                steps[1].status = 'failed';
                steps[1].error = (e as Error).message;
                await logEvent(db, email, 'verify_email_timeout', 'error', `No verification email within 300s: ${(e as Error).message}`);
                throw e;
            }

            // Step 3: Follow verify link
            steps.push({ step: 'verify', status: 'running' });
            let tokens: any;
            try {
                tokens = await supa.verifyEmail(steps[1].verifyUrl ? steps[1].verifyUrl.replace('...', '') : '');
                await db.prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, status = ?, updated_at = ? WHERE email = ?')
                    .bind(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, 'verified', Date.now(), email).run();
                steps[2].status = 'completed';
                await logEvent(db, email, 'verify_completed', 'info', 'Email verified, JWT obtained', { expires_in: tokens.expiresIn });
            } catch (e) {
                steps[2].status = 'failed';
                steps[2].error = (e as Error).message;
                await logEvent(db, email, 'verify_failed', 'error', `Verify failed: ${(e as Error).message}`);
                throw e;
            }

            // Step 4: Get user
            steps.push({ step: 'get_user', status: 'running' });
            const user = await supa.getUser(tokens.accessToken);
            steps[3].status = 'completed';

            // Step 5: Create profile
            steps.push({ step: 'profile', status: 'running' });
            const profile = await supa.createProfile(tokens.accessToken);
            await db.prepare('UPDATE accounts SET user_id = ?, profile_id = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(user.id, profile.id, 'profiled', Date.now(), email).run();
            steps[4].status = 'completed';
            await logEvent(db, email, 'profile_created', 'info', `Profile created: id=${profile.id}`);

            // Step 6: Create org
            steps.push({ step: 'org', status: 'running' });
            const org = await supa.createOrganization(tokens.accessToken, orgName);
            await db.prepare('UPDATE accounts SET org_id = ?, org_slug = ?, org_name = ?, plan_id = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(org.id, org.slug, org.name, org.plan?.id || 'free', 'org_created', Date.now(), email).run();
            steps[5].status = 'completed';
            await logEvent(db, email, 'org_created', 'info', `Org created: ${org.name} (slug=${org.slug})`);

            // Step 7: Generate PAT
            steps.push({ step: 'pat', status: 'running' });
            const expiresAt = new Date(Date.now() + patExpiresInDays * 86400000);
            const pat = await supa.createPAT(tokens.accessToken, patName, expiresAt);
            await db.prepare('UPDATE accounts SET pat = ?, pat_id = ?, pat_name = ?, pat_alias = ?, pat_expires_at = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(pat.token, pat.id, pat.name, pat.token_alias, pat.expires_at, 'complete', Date.now(), email).run();
            steps[6].status = 'completed';
            steps[6].pat = pat.token;
            await logEvent(db, email, 'pat_created', 'info', `PAT created: ${pat.token_alias}`);

            // Update job
            const report = {
                email, userId: user.id, profileId: profile.id,
                orgSlug: org.slug, orgName: org.name, planId: org.plan?.id,
                pat: pat.token, patAlias: pat.token_alias, patExpiresAt: pat.expires_at,
                steps,
            };
            await db.prepare('UPDATE jobs SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?')
                .bind('completed', JSON.stringify(report), Date.now(), Date.now(), jobId).run();
            await logEvent(db, email, 'pipeline_completed', 'info', 'Pipeline completed successfully', { pat: pat.token.slice(0, 12) + '...' });
        } catch (err) {
            const errorMsg = (err as Error).message;
            const failedStep = steps.find(s => s.status === 'failed');
            steps.push({ step: 'error', status: 'failed', error: errorMsg, failedStep: failedStep?.step });
            await db.prepare('UPDATE jobs SET status = ?, error = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?')
                .bind('failed', errorMsg, JSON.stringify({ steps }), Date.now(), Date.now(), jobId).run();
            await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                .bind('failed', Date.now(), email).run();
            await logEvent(db, email, 'pipeline_failed', 'error', `Pipeline failed at step '${failedStep?.step || 'unknown'}': ${errorMsg}`, {
                error: errorMsg,
                stack: (err as Error).stack,
                failedStep: failedStep?.step,
                steps,
            });
        }
    })());

    return c.json({ jobId, email, password, status: 'running' }, 202);
});

function generatePassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const special = '!@#$%&*';
    const all = upper + lower + digits + special;
    let pw = '';
    pw += upper[Math.floor(Math.random() * upper.length)];
    pw += lower[Math.floor(Math.random() * lower.length)];
    pw += digits[Math.floor(Math.random() * digits.length)];
    pw += special[Math.floor(Math.random() * special.length)];
    for (let i = 0; i < 12; i++) pw += all[Math.floor(Math.random() * all.length)];
    return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// --- Dashboard UI ---
app.get('/', (c) => {
    return c.html(dashboardHTML());
});

// (dashboardHTML moved to dashboard.ts)

// --- JWT refresh endpoint ---
// Refreshes a JWT using the refresh_token from the verify flow.
// The refresh_token ROTATES — the old one is invalidated.
app.post('/api/refresh-jwt', async (c) => {
    const body = await c.req.json();
    if (!body.refreshToken) {
        return c.json({ error: 'Missing refreshToken' }, 400);
    }
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const tokens = await supa.refreshJWT(body.refreshToken);
        return c.json({ ok: true, ...tokens });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 500);
    }
});

// --- /platform/* proxy endpoints (require JWT, not PAT) ---
// These let the dashboard call /platform/* endpoints via the worker
// (avoids CORS + centralizes JWT refresh logic)

app.post('/api/platform/*', async (c) => {
    const body = await c.req.json();
    const accessToken = body.accessToken;
    const method = body.method || 'GET';
    const path = body.path;
    const reqBody = body.body;

    if (!accessToken || !path) {
        return c.json({ error: 'Missing accessToken or path' }, 400);
    }

    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        let result: any;
        if (method === 'GET') {
            result = await supa.platformGet(accessToken, path);
        } else if (method === 'PATCH') {
            result = await supa.platformPatch(accessToken, path, reqBody);
        } else if (method === 'DELETE') {
            result = await supa.platformDelete(accessToken, path);
        } else {
            return c.json({ error: `Unsupported method: ${method}` }, 400);
        }
        return c.json({ ok: true, data: result });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- Billing endpoints (convenience wrappers) ---

app.get('/api/billing/:slug/subscription', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.getBillingSubscription(body.accessToken, c.req.param('slug'));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

app.get('/api/billing/:slug/plans', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.getBillingPlans(body.accessToken, c.req.param('slug'));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

app.get('/api/billing/:slug/invoices', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.getInvoices(body.accessToken, c.req.param('slug'));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

app.get('/api/billing/:slug/usage', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.getOrgUsage(body.accessToken, c.req.param('slug'));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- Org management (mutating) ---

app.post('/api/orgs/:slug/rename', async (c) => {
    const body = await c.req.json();
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.renameOrg(body.accessToken, c.req.param('slug'), body.name);
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

app.delete('/api/orgs/:slug', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.deleteOrg(body.accessToken, c.req.param('slug'));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- PAT lifecycle (JWT-authenticated) ---

app.get('/api/pats', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.listPATs(body.accessToken);
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

app.delete('/api/pats/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const data = await supa.deletePAT(body.accessToken, parseInt(c.req.param('id'), 10));
        return c.json({ ok: true, data });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- Health check (individual account) ---
// Checks PAT validity, JWT validity, account standing, project status
app.post('/api/accounts/:id/health', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const account = await db.prepare('SELECT * FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).first() as any;
    if (!account) return c.json({ error: 'Not found' }, 404);

    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        const health = await supa.checkHealth(
            account.pat || '',
            account.access_token || undefined,
            account.refresh_token || undefined,
        );

        // Update D1 with refreshed JWT if we got one
        if (health.jwt_refreshed) {
            // Re-check with fresh JWT to get the new tokens
            try {
                const newTokens = await supa.refreshJWT(account.refresh_token);
                await db.prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE email = ?')
                    .bind(newTokens.accessToken, newTokens.refreshToken, newTokens.expiresAt, Date.now(), account.email).run();
            } catch {}
        }

        // Update account status based on health
        let newStatus = account.status;
        if (!health.pat_valid && !health.jwt_valid) {
            newStatus = 'tokens_invalid';
        } else if (health.account_standing === 'disabled') {
            newStatus = 'disabled';
        } else if (health.pat_valid && health.jwt_valid) {
            newStatus = 'healthy';
        }
        if (newStatus !== account.status) {
            await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                .bind(newStatus, Date.now(), account.email).run();
            await logEvent(db, account.email, 'status_changed', 'warn',
                `Status changed: ${account.status} → ${newStatus}`,
                { old: account.status, new: newStatus, health });
        }

        // Log health check result
        await logEvent(db, account.email, 'health_check', health.pat_valid ? 'info' : 'warn',
            `Health: PAT=${health.pat_valid ? '✓' : '✗'} JWT=${health.jwt_valid ? '✓' : '✗'} standing=${health.account_standing}`,
            { pat_valid: health.pat_valid, jwt_valid: health.jwt_valid, jwt_refreshed: health.jwt_refreshed, account_standing: health.account_standing, errors: health.errors });

        return c.json({ ok: true, email: account.email, health, status: newStatus });
    } catch (err) {
        await logEvent(db, id, 'health_check_error', 'error', `Health check error: ${(err as Error).message}`);
        return c.json({ ok: false, error: (err as Error).message }, 500);
    }
});

// --- Health check (batch — all accounts) ---
app.post('/api/health-check-all', async (c) => {
    const db = c.env.DB as D1Database;
    const results = await db.prepare('SELECT email, pat, access_token, refresh_token, status FROM accounts ORDER BY created_at DESC LIMIT 200').all();
    const supa = new SupabaseAutomation(null as any, c.env);

    const reports: any[] = [];
    for (const account of results.results as any[]) {
        if (!account.pat) {
            reports.push({ email: account.email, status: 'no_pat', pat_valid: false, jwt_valid: false });
            continue;
        }
        try {
            const health = await supa.checkHealth(
                account.pat,
                account.access_token || undefined,
                account.refresh_token || undefined,
            );
            reports.push({
                email: account.email,
                pat_valid: health.pat_valid,
                jwt_valid: health.jwt_valid,
                jwt_refreshed: health.jwt_refreshed,
                account_standing: health.account_standing,
                org_count: health.organizations.length,
                project_count: health.projects.length,
                errors: health.errors,
            });

            // Update status
            let newStatus = account.status;
            if (!health.pat_valid && !health.jwt_valid) newStatus = 'tokens_invalid';
            else if (health.account_standing === 'disabled') newStatus = 'disabled';
            else if (health.pat_valid && health.jwt_valid) newStatus = 'healthy';
            if (newStatus !== account.status) {
                await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                    .bind(newStatus, Date.now(), account.email).run();
            }
        } catch (err) {
            reports.push({ email: account.email, error: (err as Error).message });
        }
    }

    const summary = {
        total: reports.length,
        healthy: reports.filter(r => r.pat_valid && r.jwt_valid).length,
        pat_invalid: reports.filter(r => !r.pat_valid).length,
        jwt_invalid: reports.filter(r => r.pat_valid && !r.jwt_valid).length,
        disabled: reports.filter(r => r.account_standing === 'disabled').length,
    };

    return c.json({ ok: true, summary, reports });
});

// --- Account detail (inspector data) ---
// Returns full account details for the inspector panel
app.get('/api/accounts/:id/detail', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const account = await db.prepare('SELECT * FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).first() as any;
    if (!account) return c.json({ error: 'Not found' }, 404);

    // Don't return full PAT/JWT in the list — only on explicit detail request
    // Mask the PAT for display
    const patMasked = account.pat ? account.pat.slice(0, 8) + '••••••••' + account.pat.slice(-4) : null;
    const jwtMasked = account.access_token ? account.access_token.slice(0, 20) + '...' : null;

    return c.json({
        account: {
            ...account,
            pat_masked: patMasked,
            jwt_masked: jwtMasked,
            // Keep full pat + access_token for health check / copy
            pat: account.pat,
            access_token: account.access_token,
        },
    });
});

// --- Event logs (for inspector Logs tab) ---
app.get('/api/accounts/:id/events', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const results = await db.prepare(
        'SELECT id, event_type, severity, message, details, created_at FROM event_logs WHERE account_email = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(id, limit).all();
    return c.json({ events: results.results });
});

// --- All recent events (system-wide) ---
app.get('/api/events', async (c) => {
    const db = c.env.DB as D1Database;
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const severity = c.req.query('severity');
    let query = 'SELECT id, account_email, event_type, severity, message, details, created_at FROM event_logs';
    const params: any[] = [];
    if (severity) {
        query += ' WHERE severity = ?';
        params.push(severity);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const results = await db.prepare(query).bind(...params).all();
    return c.json({ events: results.results });
});

// --- Billing + org data (for inspector Billing tab, requires JWT) ---
app.post('/api/accounts/:id/billing', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const account = await db.prepare('SELECT access_token, refresh_token, org_slug FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).first() as any;
    if (!account) return c.json({ error: 'Not found' }, 404);
    if (!account.access_token) return c.json({ error: 'No JWT stored — re-login needed' }, 400);
    if (!account.org_slug) return c.json({ error: 'No org slug' }, 400);

    const supa = new SupabaseAutomation(null as any, c.env);
    try {
        let jwt = account.access_token;
        // Try to get billing data, refresh JWT if expired
        try {
            const [subscription, plans, invoices, usage] = await Promise.all([
                supa.getBillingSubscription(jwt, account.org_slug),
                supa.getBillingPlans(jwt, account.org_slug),
                supa.getInvoices(jwt, account.org_slug),
                supa.getOrgUsage(jwt, account.org_slug),
            ]);
            return c.json({ ok: true, subscription, plans, invoices, usage });
        } catch (e) {
            // JWT might be expired — try refresh
            if (account.refresh_token) {
                const newTokens = await supa.refreshJWT(account.refresh_token);
                await db.prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE email = ?')
                    .bind(newTokens.accessToken, newTokens.refreshToken, newTokens.expiresAt, Date.now(), id).run();
                jwt = newTokens.accessToken;
                const [subscription, plans, invoices, usage] = await Promise.all([
                    supa.getBillingSubscription(jwt, account.org_slug),
                    supa.getBillingPlans(jwt, account.org_slug),
                    supa.getInvoices(jwt, account.org_slug),
                    supa.getOrgUsage(jwt, account.org_slug),
                ]);
                return c.json({ ok: true, subscription, plans, invoices, usage });
            }
            throw e;
        }
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- Projects data (for inspector Projects tab, uses PAT) ---
app.post('/api/accounts/:id/projects', async (c) => {
    const db = c.env.DB as D1Database;
    const id = c.req.param('id');
    const account = await db.prepare('SELECT pat FROM accounts WHERE email = ? OR user_id = ?').bind(id, id).first() as any;
    if (!account) return c.json({ error: 'Not found' }, 404);
    if (!account.pat) return c.json({ error: 'No PAT stored' }, 400);

    try {
        const r = await fetch('https://api.supabase.com/v1/projects', {
            headers: { 'Authorization': `Bearer ${account.pat}` },
        });
        if (!r.ok) return c.json({ ok: false, error: `Failed: ${r.status}` }, r.status as any);
        const projects: any[] = await r.json();
        // For each project, get its status
        const detailedProjects = await Promise.all(projects.map(async (p: any) => {
            try {
                const statusR = await fetch(`https://api.supabase.com/v1/projects/${p.ref}`, {
                    headers: { 'Authorization': `Bearer ${account.pat}` },
                });
                const detail: any = statusR.ok ? await statusR.json() : {};
                return { ...p, ...detail };
            } catch {
                return p;
            }
        }));
        return c.json({ ok: true, projects: detailedProjects });
    } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 502);
    }
});

// --- WebSocket upgrade for extension + dashboard ---
app.get('/ws', async (c) => {
    const hub = getHub(c);
    // Forward the WebSocket upgrade to the Durable Object
    const upgradeHeaders = new Headers(c.req.raw.headers);
    if (c.env.BRIDGE_TOKEN) {
        upgradeHeaders.set('x-bridge-token', c.req.header('authorization')?.replace('Bearer ', '') || '');
    }
    const res = await hub.fetch(new Request('https://do/ws', {
        method: 'GET',
        headers: upgradeHeaders,
    }));
    return res;
});

app.get('/ws/dashboard', async (c) => {
    const hub = getHub(c);
    const res = await hub.fetch(new Request('https://do/ws/dashboard', {
        method: 'GET',
        headers: c.req.raw.headers,
    }));
    return res;
});


export default app;
