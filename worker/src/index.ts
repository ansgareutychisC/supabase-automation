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

// --- Extension status ---
app.get('/api/extensions', async (c) => {
    const hub = c.env.BRIDGE_HUB as any /* DurableObjectNamespace */;
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

    const hub = c.env.BRIDGE_HUB as any /* DurableObjectNamespace */;
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
    const hub = c.env.BRIDGE_HUB as any /* DurableObjectNamespace */;
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
        try {
            // Step 1: Signup via extension (hCaptcha)
            steps.push({ step: 'signup', status: 'running' });
            await supa.signupViaExtension(email, password);
            await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                .bind('signed_up', Date.now(), email).run();
            steps[0].status = 'completed';
            steps[0].note = 'hCaptcha solved by user in browser';

            // Step 2: Poll for verify email
            steps.push({ step: 'verify_email', status: 'running' });
            const { url: verifyUrl } = await supa.waitForVerifyEmail(email, 300);
            steps[1].status = 'completed';

            // Step 3: Follow verify link
            steps.push({ step: 'verify', status: 'running' });
            const tokens = await supa.verifyEmail(verifyUrl);
            await db.prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, 'verified', Date.now(), email).run();
            steps[2].status = 'completed';

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

            // Step 6: Create org
            steps.push({ step: 'org', status: 'running' });
            const org = await supa.createOrganization(tokens.accessToken, orgName);
            await db.prepare('UPDATE accounts SET org_id = ?, org_slug = ?, org_name = ?, plan_id = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(org.id, org.slug, org.name, org.plan?.id || 'free', 'org_created', Date.now(), email).run();
            steps[5].status = 'completed';

            // Step 7: Generate PAT
            steps.push({ step: 'pat', status: 'running' });
            const expiresAt = new Date(Date.now() + patExpiresInDays * 86400000);
            const pat = await supa.createPAT(tokens.accessToken, patName, expiresAt);
            await db.prepare('UPDATE accounts SET pat = ?, pat_id = ?, pat_name = ?, pat_alias = ?, pat_expires_at = ?, status = ?, updated_at = ? WHERE email = ?')
                .bind(pat.token, pat.id, pat.name, pat.token_alias, pat.expires_at, 'complete', Date.now(), email).run();
            steps[6].status = 'completed';
            steps[6].pat = pat.token;

            // Update job
            const report = {
                email, userId: user.id, profileId: profile.id,
                orgSlug: org.slug, orgName: org.name, planId: org.plan?.id,
                pat: pat.token, patAlias: pat.token_alias, patExpiresAt: pat.expires_at,
                steps,
            };
            await db.prepare('UPDATE jobs SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?')
                .bind('completed', JSON.stringify(report), Date.now(), Date.now(), jobId).run();
        } catch (err) {
            const errorMsg = (err as Error).message;
            steps.push({ step: 'error', status: 'failed', error: errorMsg });
            await db.prepare('UPDATE jobs SET status = ?, error = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?')
                .bind('failed', errorMsg, JSON.stringify({ steps }), Date.now(), Date.now(), jobId).run();
            await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE email = ?')
                .bind('failed', Date.now(), email).run();
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

// --- WebSocket upgrade for extension + dashboard ---
app.get('/ws', async (c) => {
    const hub = c.env.BRIDGE_HUB as any /* DurableObjectNamespace */;
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
    const hub = c.env.BRIDGE_HUB as any /* DurableObjectNamespace */;
    const res = await hub.fetch(new Request('https://do/ws/dashboard', {
        method: 'GET',
        headers: c.req.raw.headers,
    }));
    return res;
});

function dashboardHTML(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supabase Onboarding Fleet Manager</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f23; color: #e0e0e0; padding: 20px; max-width: 1000px; margin: 0 auto; }
h1 { color: #3ECF8E; margin-bottom: 8px; font-size: 24px; }
h2 { font-size: 14px; color: #888; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.card { background: #16213e; padding: 20px; border-radius: 8px; margin-bottom: 16px; }
label { display: block; margin-bottom: 4px; color: #888; font-size: 12px; text-transform: uppercase; }
input, select { width: 100%; padding: 8px; border: 1px solid #333; border-radius: 4px; background: #0f0f23; color: #e0e0e0; margin-bottom: 12px; font-size: 13px; }
button { padding: 10px 24px; border: none; border-radius: 6px; background: #3ECF8E; color: #1a1a2e; font-weight: 600; cursor: pointer; font-size: 13px; }
button:hover { background: #2EAF6E; }
button.secondary { background: #333; color: #e0e0e0; }
button.secondary:hover { background: #444; }
button.danger { background: #e76f51; color: white; }
.status { padding: 8px 12px; border-radius: 4px; margin-top: 8px; font-size: 13px; }
.status.running { background: #1b4332; color: #52b788; }
.status.failed { background: #4a1e1e; color: #e76f51; }
.status.completed { background: #1b4332; color: #52b788; }
#result { margin-top: 16px; white-space: pre-wrap; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; max-height: 400px; overflow-y: auto; background: #0f0f23; padding: 12px; border-radius: 6px; border: 1px solid #333; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
th { color: #888; }
.row { display: flex; gap: 12px; }
.row > div { flex: 1; }
.pat-highlight { background: #3a3a00; color: #ffeb3b; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
.checkbox-group { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
.checkbox-group input { width: auto; margin: 0; }
.ext-connected { color: #52b788; }
.ext-disconnected { color: #e76f51; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; }
.tab { padding: 8px 16px; border-radius: 6px 6px 0 0; background: #16213e; cursor: pointer; font-size: 13px; }
.tab.active { background: #3ECF8E; color: #1a1a2e; }
.hidden { display: none; }
.actions { display: flex; gap: 4px; }
.actions button { padding: 4px 10px; font-size: 11px; }
</style>
</head>
<body>
<h1>🚀 Supabase Onboarding Fleet Manager</h1>
<p style="color:#888;font-size:13px;margin-bottom:20px;">Automate Supabase account creation, verification, and PAT generation.</p>

<div class="tab-bar">
  <div class="tab active" onclick="showTab('onboard')">Onboard</div>
  <div class="tab" onclick="showTab('fleet')">Fleet</div>
  <div class="tab" onclick="showTab('import')">Import/Export</div>
</div>

<!-- Onboard Tab -->
<div id="tab-onboard">
  <div class="card">
    <h2>Extension Status</h2>
    <div id="extStatus">Checking...</div>
  </div>

  <div class="card">
    <h2>Create New Account</h2>
    <div class="row">
      <div><label>Email (blank for auto)</label><input id="email" placeholder="auto@privatimail.com"></div>
      <div><label>Password (blank for auto)</label><input id="password" placeholder="auto-generated"></div>
    </div>
    <div class="row">
      <div><label>Org Name (blank for default)</label><input id="orgName" placeholder="<email>'s Org"></div>
      <div><label>PAT Name</label><input id="patName" value="automation-token"></div>
    </div>
    <div class="row">
      <div><label>PAT Expiry (days)</label><input id="patDays" type="number" value="30"></div>
    </div>
    <div class="checkbox-group">
      <input type="checkbox" id="createOrg" checked>
      <label for="createOrg" style="text-transform:none;">Create organization</label>
    </div>
    <div class="checkbox-group">
      <input type="checkbox" id="createPat" checked>
      <label for="createPat" style="text-transform:none;">Generate PAT</label>
    </div>
    <button onclick="runPipeline()">Run Full Pipeline</button>
    <div id="status"></div>
  </div>
</div>

<!-- Fleet Tab -->
<div id="tab-fleet" class="hidden">
  <div class="card">
    <h2>Account Fleet</h2>
    <div id="accounts">Loading...</div>
  </div>
  <div class="card">
    <h2>Job History</h2>
    <div id="jobs">Loading...</div>
  </div>
</div>

<!-- Import/Export Tab -->
<div id="tab-import" class="hidden">
  <div class="card">
    <h2>Import Account</h2>
    <div class="row">
      <div><label>Email</label><input id="impEmail"></div>
      <div><label>Password</label><input id="impPassword"></div>
    </div>
    <div class="row">
      <div><label>PAT (sbp_...)</label><input id="impPat"></div>
      <div><label>User ID</label><input id="impUserId"></div>
    </div>
    <button onclick="importAccount()">Import</button>
    <div id="importResult"></div>
  </div>

  <div class="card">
    <h2>Export All Accounts</h2>
    <button onclick="exportAccounts()" class="secondary">Export as JSON</button>
    <div id="exportResult"></div>
  </div>
</div>

<div id="result"></div>

<script>
const AUTH_TOKEN = ''; // Set if BRIDGE_TOKEN is set; for dev mode, worker allows no-auth

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  const r = await fetch(path, { ...opts, headers });
  return r;
}

function showTab(name) {
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.classList.add('hidden'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab')[name === 'onboard' ? 0 : name === 'fleet' ? 1 : 2].classList.add('active');
  if (name === 'fleet') { loadAccounts(); loadJobs(); }
}

async function checkExtensions() {
  try {
    const r = await api('/api/extensions');
    const data = await r.json();
    const exts = data.extensions || [];
    document.getElementById('extStatus').innerHTML = exts.length > 0
      ? '<span class="ext-connected">✓ ' + exts.length + ' extension(s) connected</span> — ' + exts.map(e => e.agentId + ' (' + e.commandCount + ' cmds)').join(', ')
      : '<span class="ext-disconnected">✗ No extension connected</span> — Load the extension and click Connect';
  } catch (e) { document.getElementById('extStatus').textContent = 'Error: ' + e.message; }
}

async function loadAccounts() {
  try {
    const r = await api('/api/accounts');
    const data = await r.json();
    if (!data.accounts?.length) { document.getElementById('accounts').innerHTML = 'No accounts yet'; return; }
    let html = '<table><tr><th>Email</th><th>Org</th><th>PAT</th><th>Status</th><th>Created</th><th>Actions</th></tr>';
    for (const a of data.accounts) {
      html += '<tr>'
        + '<td>' + a.email + '</td>'
        + '<td>' + (a.org_name || '-') + '</td>'
        + '<td>' + (a.pat_alias || '-') + '</td>'
        + '<td>' + a.status + '</td>'
        + '<td>' + new Date(a.created_at).toLocaleString() + '</td>'
        + '<td class="actions">'
        + '<button class="secondary" onclick="showPat(\\'' + a.email + '\\')">PAT</button>'
        + '<button class="secondary" onclick="relogin(\\'' + a.email + '\\')">Re-login</button>'
        + '<button class="danger" onclick="deleteAccount(\\'' + a.email + '\\')">Del</button>'
        + '</td></tr>';
    }
    html += '</table>';
    document.getElementById('accounts').innerHTML = html;
  } catch (e) { document.getElementById('accounts').textContent = 'Error: ' + e.message; }
}

async function loadJobs() {
  try {
    const r = await api('/api/jobs');
    const data = await r.json();
    if (!data.jobs?.length) { document.getElementById('jobs').innerHTML = 'No jobs yet'; return; }
    let html = '<table><tr><th>ID</th><th>Email</th><th>Stage</th><th>Status</th><th>Started</th></tr>';
    for (const j of data.jobs) {
      html += '<tr><td>' + j.id.slice(0,8) + '...</td><td>' + (j.account_email||'-') + '</td><td>' + j.stage + '</td><td>' + j.status + '</td><td>' + (j.started_at ? new Date(j.started_at).toLocaleString() : '-') + '</td></tr>';
    }
    html += '</table>';
    document.getElementById('jobs').innerHTML = html;
  } catch (e) { document.getElementById('jobs').textContent = 'Error: ' + e.message; }
}

async function runPipeline() {
  const body = {
    email: document.getElementById('email').value || undefined,
    password: document.getElementById('password').value || undefined,
    orgName: document.getElementById('orgName').value || undefined,
    patName: document.getElementById('patName').value,
    patExpiresInDays: parseInt(document.getElementById('patDays').value) || 30,
  };
  document.getElementById('status').innerHTML = '<div class="status running">Starting pipeline...</div>';
  document.getElementById('result').textContent = '';
  try {
    const r = await api('/api/run', { method: 'POST', body: JSON.stringify(body) });
    const data = await r.json();
    if (r.status === 202) {
      document.getElementById('status').innerHTML = '<div class="status running">Job ' + data.jobId.slice(0,8) + ' running for ' + data.email + ' (password: ' + data.password + ')</div>';
      pollJob(data.jobId);
    } else {
      document.getElementById('status').innerHTML = '<div class="status failed">Error: ' + JSON.stringify(data) + '</div>';
    }
  } catch (e) {
    document.getElementById('status').innerHTML = '<div class="status failed">Error: ' + e.message + '</div>';
  }
}

async function pollJob(jobId) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r = await api('/api/jobs');
      const data = await r.json();
      const job = data.jobs?.find(j => j.id === jobId);
      if (job) {
        const result = JSON.parse(job.result || job.error || '{}');
        document.getElementById('result').textContent = JSON.stringify(result, null, 2);
        if (job.status === 'completed') {
          const pat = result.pat || result.steps?.find(s => s.step === 'pat')?.pat;
          document.getElementById('status').innerHTML = '<div class="status completed">✓ Pipeline completed! PAT: <span class="pat-highlight">' + pat + '</span></div>';
          loadAccounts();
          return;
        }
        if (job.status === 'failed') {
          document.getElementById('status').innerHTML = '<div class="status failed">✗ Failed: ' + job.error + '</div>';
          return;
        }
      }
    } catch (e) {}
  }
  document.getElementById('status').innerHTML = '<div class="status failed">Timed out waiting for job</div>';
}

async function showPat(email) {
  const r = await api('/api/accounts/' + encodeURIComponent(email) + '/pat');
  const data = await r.json();
  if (data.account?.pat) {
    alert('PAT for ' + email + ':\\n\\n' + data.account.pat + '\\n\\nAlias: ' + data.account.pat_alias + '\\nExpires: ' + data.account.pat_expires_at);
  } else {
    alert('No PAT for ' + email);
  }
}

async function relogin(email) {
  if (!confirm('Send password reset email for ' + email + '?')) return;
  const r = await api('/api/accounts/' + encodeURIComponent(email) + '/relogin', { method: 'POST' });
  const data = await r.json();
  alert(data.note || JSON.stringify(data));
}

async function deleteAccount(email) {
  if (!confirm('Delete account ' + email + '?')) return;
  await api('/api/accounts/' + encodeURIComponent(email), { method: 'DELETE' });
  loadAccounts();
}

async function importAccount() {
  const body = {
    email: document.getElementById('impEmail').value,
    password: document.getElementById('impPassword').value,
    pat: document.getElementById('impPat').value,
    user_id: document.getElementById('impUserId').value,
  };
  const r = await api('/api/accounts/import', { method: 'POST', body: JSON.stringify(body) });
  const data = await r.json();
  document.getElementById('importResult').innerHTML = '<div class="status completed">Imported: ' + JSON.stringify(data) + '</div>';
}

async function exportAccounts() {
  const r = await api('/api/accounts/export', { method: 'POST' });
  const data = await r.json();
  document.getElementById('exportResult').innerHTML = '<div class="status completed">Exported ' + data.count + ' accounts. <a href="data:application/json,' + encodeURIComponent(JSON.stringify(data, null, 2)) + '" download="supabase-accounts-export.json">Download JSON</a></div>';
}

// Init
checkExtensions();
setInterval(checkExtensions, 10000);
</script>
</body>
</html>`;
}

export default app;
