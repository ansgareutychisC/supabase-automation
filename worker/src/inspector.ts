/**
 * Inspector panel HTML + JS — exported as a string to be injected into the dashboard.
 *
 * This is kept separate to avoid template-literal escaping issues in dashboard.ts.
 * The dashboard injects this via a placeholder.
 */
export function inspectorHTML(): string {
    return `
<!-- Inspector panel (tabbed) -->
<div class="overlay" id="inspector-overlay" role="dialog" aria-modal="true">
  <div class="overlay-card" style="max-width:760px;max-height:90vh;display:flex;flex-direction:column">
    <button class="overlay-close" id="inspector-close" aria-label="Close">×</button>
    <h2 style="font-size:1.1rem;margin-bottom:0.5rem">Account Inspector</h2>
    <div id="inspector-header" style="font-size:12px;color:var(--muted);margin-bottom:0.75rem"></div>
    <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:0.75rem;flex-shrink:0">
      <button class="insp-tab active" data-tab="overview" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--accent);cursor:pointer;border-bottom:2px solid var(--accent);border-radius:4px 4px 0 0">Overview <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">1</span></button>
      <button class="insp-tab" data-tab="tokens" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0">Tokens <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">2</span></button>
      <button class="insp-tab" data-tab="billing" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0">Billing <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">3</span></button>
      <button class="insp-tab" data-tab="projects" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0">Projects <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">4</span></button>
      <button class="insp-tab" data-tab="logs" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0">Logs <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">5</span></button>
      <button class="insp-tab" data-tab="raw" style="padding:6px 12px;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0">Raw <span style="background:var(--kbd-bg);padding:0 4px;border-radius:3px;font-size:9px">6</span></button>
      <button class="secondary" id="insp-refresh" style="margin-left:auto;padding:4px 10px;font-size:11px">Refresh (r)</button>
    </div>
    <div id="inspector-body" style="font-size:13px;line-height:1.6;overflow-y:auto;flex:1;min-height:0"></div>
  </div>
</div>
`;
}

export function inspectorJS(): string {
    return `
// Inspector panel (tabbed)
const inspectorOverlay = document.getElementById('inspector-overlay');
const inspectorClose = document.getElementById('inspector-close');
const inspectorBody = document.getElementById('inspector-body');
const inspectorHeader = document.getElementById('inspector-header');
const inspRefreshBtn = document.getElementById('insp-refresh');
const inspTabs = Array.from(document.querySelectorAll('.insp-tab'));

const inspCache = {};
let inspCurrentEmail = null;
let inspCurrentTab = 'overview';

function inspIsCached(email, tab) {
  const k = email + '::' + tab;
  return inspCache[k] && (Date.now() - inspCache[k].fetchedAt < 60000);
}
function inspGetCache(email, tab) {
  return (inspCache[email + '::' + tab] || {}).data;
}
function inspSetCache(email, tab, data) {
  inspCache[email + '::' + tab] = { data, fetchedAt: Date.now() };
}
function inspClearCache(email) {
  Object.keys(inspCache).forEach(k => { if (k.startsWith(email + '::')) delete inspCache[k]; });
}

function switchInspectorTab(tab) {
  inspCurrentTab = tab;
  inspTabs.forEach(t => {
    const active = t.dataset.tab === tab;
    t.style.color = active ? 'var(--accent)' : 'var(--muted)';
    t.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
  });
  renderInspectorTab(tab);
}
inspTabs.forEach(t => t.addEventListener('click', () => switchInspectorTab(t.dataset.tab)));

async function openInspector(email) {
  inspCurrentEmail = email;
  inspClearCache(email);
  inspectorOverlay.classList.add('open');
  inspectorHeader.textContent = 'Loading...';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/detail');
    const data = await r.json();
    if (!data.account) { inspectorBody.textContent = 'Not found'; return; }
    inspSetCache(email, 'detail', data.account);
    const a = data.account;
    inspectorHeader.innerHTML = '<strong>' + escapeHtml(a.email) + '</strong> - ' + escapeHtml(a.status || '-') + ' - ' + escapeHtml(a.org_name || 'no org');
    switchInspectorTab('overview');
  } catch (e) {
    inspectorBody.textContent = 'Error: ' + e.message;
  }
}

function closeInspector() {
  inspectorOverlay.classList.remove('open');
  inspCurrentEmail = null;
}
inspectorClose.addEventListener('click', closeInspector);
inspectorOverlay.addEventListener('click', (e) => { if (e.target === inspectorOverlay) closeInspector(); });
inspRefreshBtn.addEventListener('click', () => {
  if (inspCurrentEmail) {
    inspClearCache(inspCurrentEmail);
    renderInspectorTab(inspCurrentTab);
    toast('Refreshed', 'success');
  }
});

async function renderInspectorTab(tab) {
  if (!inspCurrentEmail) return;
  const email = inspCurrentEmail;
  const account = inspGetCache(email, 'detail');
  if (!account) { inspectorBody.textContent = 'Loading...'; return; }

  if (tab === 'overview') renderOverviewTab(account);
  else if (tab === 'tokens') renderTokensTab(account);
  else if (tab === 'billing') await renderBillingTab(email);
  else if (tab === 'projects') await renderProjectsTab(email);
  else if (tab === 'logs') await renderLogsTab(email);
  else if (tab === 'raw') renderRawTab(account);
}

function renderOverviewTab(a) {
  const fmtTs = (ts) => ts ? new Date(ts).toLocaleString() : '-';
  inspectorBody.innerHTML =
    '<div style="display:grid;gap:0.75rem">' +
      '<div><div style="font-weight:600;color:var(--accent);margin-bottom:0.35rem">Status: ' + escapeHtml(a.status || '-') + '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem 1.5rem;font-size:12px">' +
          '<div><span style="color:var(--muted)">Email:</span> ' + escapeHtml(a.email || '-') + '</div>' +
          '<div><span style="color:var(--muted)">User ID:</span> <code>' + escapeHtml((a.user_id || '-').slice(0, 36)) + '</code></div>' +
          '<div><span style="color:var(--muted)">Profile ID:</span> ' + (a.profile_id || '-') + '</div>' +
          '<div><span style="color:var(--muted)">Plan:</span> ' + escapeHtml(a.plan_id || 'free') + '</div>' +
          '<div><span style="color:var(--muted)">Org:</span> ' + escapeHtml(a.org_name || '-') + ' (' + escapeHtml(a.org_slug || '-') + ')</div>' +
          '<div><span style="color:var(--muted)">Created:</span> ' + fmtTs(a.created_at) + '</div>' +
        '</div>' +
      '</div>' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">Quick Actions</div>' +
        '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
          '<button class="secondary" onclick="checkHealth(\\'' + escapeHtml(a.email) + '\\')" style="padding:5px 12px;font-size:12px">Check Health</button>' +
          '<button class="secondary" onclick="copyPatForAccount({email:\\'' + escapeHtml(a.email) + '\\'})" style="padding:5px 12px;font-size:12px">Copy PAT</button>' +
          '<button class="secondary" onclick="reloginAccount({email:\\'' + escapeHtml(a.email) + '\\'})" style="padding:5px 12px;font-size:12px">Re-login</button>' +
          '<button class="danger" onclick="deleteAccount({email:\\'' + escapeHtml(a.email) + '\\'});closeInspector()" style="padding:5px 12px;font-size:12px">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div id="health-results"></div>' +
    '</div>';
}

function renderTokensTab(a) {
  const fmtDur = (ts) => {
    if (!ts) return '-';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 0) return 'in ' + Math.abs(Math.round(diff / 86400000)) + ' days';
    return Math.round(diff / 86400000) + ' days ago';
  };
  inspectorBody.innerHTML =
    '<div style="display:grid;gap:0.75rem">' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">PAT (Personal Access Token) - /v1/* Management API</div>' +
        '<div style="display:flex;align-items:center;gap:0.5rem">' +
          '<code style="font-size:11px;background:var(--code-bg);padding:4px 8px;border-radius:4px;flex:1;word-break:break-all">' + escapeHtml(a.pat_masked || '-') + '</code>' +
          '<button class="secondary" onclick="copyText(\\'' + (a.pat || '').replace(/'/g, '') + '\\',' + '\\'✓ PAT copied\\'"' + ')">Copy</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:0.25rem">Name: ' + escapeHtml(a.pat_name || '-') + ' - Expires: ' + escapeHtml(a.pat_expires_at || '-') + ' (' + fmtDur(a.pat_expires_at) + ')</div>' +
      '</div>' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">JWT (Dashboard Access) - /platform/* endpoints</div>' +
        '<div style="font-size:12px">' + (a.access_token ? '✓ Stored' : '✗ Not stored - re-login needed') + '</div>' +
        '<div style="font-size:11px;color:var(--muted)">' + (a.refresh_token ? '✓ Refresh token stored' : '✗ No refresh token') + '</div>' +
      '</div>' +
    '</div>';
}

async function renderBillingTab(email) {
  if (inspIsCached(email, 'billing')) { renderBillingData(inspGetCache(email, 'billing')); return; }
  inspectorBody.textContent = 'Loading billing data (JWT-authenticated)...';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/billing', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) { inspectorBody.innerHTML = '<div style="color:var(--error)">✗ ' + escapeHtml(data.error || 'Failed') + '</div>'; return; }
    inspSetCache(email, 'billing', data);
    renderBillingData(data);
  } catch (e) { inspectorBody.textContent = 'Error: ' + e.message; }
}

function renderBillingData(data) {
  const s = data.subscription || {};
  const plans = (data.plans && data.plans.plans) || [];
  const invoices = data.invoices || [];
  const usage = (data.usage && data.usage.usages) || [];
  inspectorBody.innerHTML =
    '<div style="display:grid;gap:0.75rem">' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">Current Plan</div>' +
        '<div>' + escapeHtml((s.plan && s.plan.name) || '-') + ' (' + escapeHtml((s.plan && s.plan.id) || '-') + ')</div>' +
        '<div style="font-size:11px;color:var(--muted)">Payment: ' + escapeHtml(s.payment_method_type || 'none') + ' - Usage billing: ' + (s.usage_billing_enabled ? 'ON' : 'OFF') + '</div>' +
      '</div>' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">Available Plans</div>' +
        '<div style="font-size:12px">' + plans.map(p => escapeHtml(p.name) + ' ($' + p.price + (p.is_current ? ' current' : '') + ')').join(' - ') + '</div>' +
      '</div>' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">Usage</div>' +
        '<div style="font-size:12px">' + usage.map(u => escapeHtml(u.metric) + ': ' + u.usage + (u.capped ? ' (capped)' : '')).join('<br>') + '</div>' +
      '</div>' +
      '<div><div style="font-weight:600;margin-bottom:0.35rem">Invoices (' + invoices.length + ')</div>' +
        (invoices.length === 0 ? '<div style="font-size:12px;color:var(--muted)">No invoices yet</div>' : '<div style="font-size:12px">' + invoices.map(i => escapeHtml(i.id || '?') + ' - ' + i.amount_total / 100 + ' - ' + escapeHtml(i.status)).join('<br>') + '</div>') +
      '</div>' +
    '</div>';
}

async function renderProjectsTab(email) {
  if (inspIsCached(email, 'projects')) { renderProjectsData(inspGetCache(email, 'projects')); return; }
  inspectorBody.textContent = 'Loading projects (PAT-authenticated)...';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/projects', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) { inspectorBody.innerHTML = '<div style="color:var(--error)">✗ ' + escapeHtml(data.error || 'Failed') + '</div>'; return; }
    inspSetCache(email, 'projects', data);
    renderProjectsData(data);
  } catch (e) { inspectorBody.textContent = 'Error: ' + e.message; }
}

function renderProjectsData(data) {
  const projects = data.projects || [];
  if (projects.length === 0) { inspectorBody.innerHTML = '<div style="color:var(--muted)">No projects</div>'; return; }
  inspectorBody.innerHTML = '<div style="display:grid;gap:0.5rem">' + projects.map(p =>
    '<div style="padding:0.5rem;border:1px solid var(--border);border-radius:4px">' +
      '<div style="font-weight:600">' + escapeHtml(p.name || '-') + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">ref: <code>' + escapeHtml(p.ref || p.id || '-') + '</code> - region: ' + escapeHtml(p.region || '-') + ' - status: <span style="color:' + (p.status === 'ACTIVE_HEALTHY' ? 'var(--success)' : 'var(--error)') + '">' + escapeHtml(p.status || '-') + '</span></div>' +
    '</div>'
  ).join('') + '</div>';
}

async function renderLogsTab(email) {
  if (inspIsCached(email, 'logs')) { renderLogsData(inspGetCache(email, 'logs')); return; }
  inspectorBody.textContent = 'Loading event logs...';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/events?limit=50');
    const data = await r.json();
    inspSetCache(email, 'logs', data);
    renderLogsData(data);
  } catch (e) { inspectorBody.textContent = 'Error: ' + e.message; }
}

function renderLogsData(data) {
  const events = data.events || [];
  if (events.length === 0) { inspectorBody.innerHTML = '<div style="color:var(--muted)">No events logged</div>'; return; }
  const sevColor = { error: 'var(--error)', warn: '#856404', info: 'var(--muted)' };
  inspectorBody.innerHTML = '<div style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;max-height:400px;overflow:auto">' + events.map(e =>
    '<div style="padding:0.35rem 0;border-bottom:1px solid var(--border)">' +
      '<div style="display:flex;gap:0.5rem;align-items:baseline">' +
        '<span style="color:var(--muted);font-size:10px">' + new Date(e.created_at).toLocaleString() + '</span>' +
        '<span style="color:' + (sevColor[e.severity] || 'var(--muted)') + ';font-weight:600;text-transform:uppercase;font-size:10px">' + escapeHtml(e.severity) + '</span>' +
        '<span style="color:var(--accent);font-size:10px">' + escapeHtml(e.event_type) + '</span>' +
      '</div>' +
      '<div style="margin-top:0.15rem">' + escapeHtml(e.message) + '</div>' +
      (e.details ? '<details style="margin-top:0.15rem"><summary style="font-size:10px;color:var(--muted);cursor:pointer">Details</summary><pre style="font-size:10px;margin-top:0.25rem;max-height:150px;overflow:auto">' + escapeHtml(e.details) + '</pre></details>' : '') +
    '</div>'
  ).join('') + '</div>';
}

function renderRawTab(a) {
  inspectorBody.innerHTML = '<pre style="font-size:11px;max-height:500px;overflow:auto;background:var(--code-bg);padding:0.75rem;border-radius:4px;border:1px solid var(--border)">' + escapeHtml(JSON.stringify(a, null, 2)) + '</pre>';
}

async function checkHealth(email) {
  const results = document.getElementById('health-results');
  if (!results) { toast('Open overview tab first', 'error'); return; }
  results.textContent = 'Checking health...';
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(email) + '/health', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) { results.innerHTML = '<span style="color:var(--error)">✗ ' + escapeHtml(data.error || 'Failed') + '</span>'; return; }
    const h = data.health;
    results.innerHTML =
      '<div style="padding:0.5rem;border:1px solid var(--border);border-radius:4px;font-size:12px">' +
        '<div style="color:' + (h.pat_valid ? 'var(--success)' : 'var(--error)') + '">' + (h.pat_valid ? '✓' : '✗') + ' PAT valid</div>' +
        '<div style="color:' + (h.jwt_valid ? 'var(--success)' : 'var(--error)') + '">' + (h.jwt_valid ? '✓' : '✗') + ' JWT valid' + (h.jwt_refreshed ? ' (refreshed)' : '') + '</div>' +
        '<div style="color:' + (h.account_standing === 'good' ? 'var(--success)' : 'var(--error)') + '">' + (h.account_standing === 'good' ? '✓' : '⚠') + ' Account standing: ' + escapeHtml(h.account_standing) + '</div>' +
        '<div>Orgs: ' + h.organizations.length + ' - Projects: ' + h.projects.length + '</div>' +
        (h.errors.length > 0 ? '<div style="color:var(--error);font-size:11px">Errors: ' + h.errors.map(e => escapeHtml(e)).join('; ') + '</div>' : '') +
      '</div>';
    toast('Health: ' + (h.pat_valid && h.jwt_valid ? 'healthy' : 'issues found'), h.pat_valid && h.jwt_valid ? 'success' : 'error');
    refreshAccounts();
    inspClearCache(email);
  } catch (e) {
    results.innerHTML = '<span style="color:var(--error)">✗ ' + escapeHtml(e.message) + '</span>';
  }
}
`;
}
