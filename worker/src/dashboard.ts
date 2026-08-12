/**
 * Dashboard HTML UI — ported from todoist-onboarding-automation.
 *
 * Features:
 * - 3 tabs: Signup, Accounts, Help (keyboard: 1/2/3 or s/a)
 * - Full keyboard navigation: j/k/arrows for rows, Enter to open reset,
 *   c to copy PAT, n for new signup, r to refresh, / for search, ? for help
 * - Dark/light mode via prefers-color-scheme
 * - Toast notifications, confirm dialogs, help modal
 * - Search/filter, sortable table, badges, relative timestamps
 * - Import (single PAT + batch JSON/CSV)
 * - Account validation with inline errors
 * - Advanced settings in collapsible <details>
 * - Extension status indicator with auto-refresh
 * - Job polling for async pipeline
 */
export function dashboardHTML(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Supabase Onboarding Worker</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #666;
    --muted-2: #888;
    --accent: #3ECF8E;
    --accent-hover: #2EAF6E;
    --accent-soft: rgba(62, 207, 142, 0.08);
    --accent-soft-2: rgba(62, 207, 142, 0.14);
    --border: #e0e0e0;
    --border-strong: #ccc;
    --input-bg: #ffffff;
    --error: #dc3545;
    --error-bg: #ffe7e7;
    --success: #1e7e34;
    --success-bg: #e7ffe9;
    --info-bg: #e7f4ff;
    --card-bg: #ffffff;
    --code-bg: #f4f4f4;
    --hover-bg: rgba(62, 207, 142, 0.06);
    --selected-bg: rgba(62, 207, 142, 0.16);
    --th-bg: #f7f7f7;
    --kbd-bg: rgba(0, 0, 0, 0.08);
    --kbd-border: rgba(0, 0, 0, 0.15);
    --overlay-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
    --radius: 8px;
    --radius-sm: 5px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1a;
      --fg: #eee;
      --muted: #aaa;
      --muted-2: #888;
      --accent: #3ECF8E;
      --accent-hover: #2EAF6E;
      --accent-soft: rgba(62, 207, 142, 0.10);
      --accent-soft-2: rgba(62, 207, 142, 0.18);
      --border: #383838;
      --border-strong: #444;
      --input-bg: #2a2a2a;
      --error: #ff6b6b;
      --error-bg: #3a1d1d;
      --success: #8fbc8f;
      --success-bg: #1e3a23;
      --info-bg: #1a2c3a;
      --card-bg: #1e1e1e;
      --code-bg: #1e1e1e;
      --hover-bg: rgba(62, 207, 142, 0.08);
      --selected-bg: rgba(62, 207, 142, 0.18);
      --th-bg: #2a2a2a;
      --kbd-bg: rgba(255, 255, 255, 0.10);
      --kbd-border: rgba(255, 255, 255, 0.20);
      --overlay-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
    }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
  p.lede { color: var(--muted); margin: 0 0 1rem; max-width: 60ch; }

  /* Extension status bar */
  .ext-bar {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.85rem; border-radius: var(--radius-sm);
    background: var(--info-bg); font-size: 13px; margin-bottom: 1rem;
  }
  .ext-bar.connected { background: var(--success-bg); color: var(--success); }
  .ext-bar.disconnected { background: var(--error-bg); color: var(--error); }
  .ext-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor; flex: 0 0 auto;
  }
  .ext-bar.connected .ext-dot { animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.5; } }

  /* Tabs */
  .tabs {
    display: flex; gap: 0; margin: 1rem 0 0;
    border-bottom: 2px solid var(--border);
    align-items: flex-end;
  }
  .tab {
    padding: 0.55rem 1.1rem; cursor: pointer;
    border: 0; background: transparent;
    color: var(--muted); font: inherit; font-weight: 600;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px; border-radius: 4px 4px 0 0;
    transition: background 0.12s, color 0.12s;
  }
  .tab:hover { background: var(--accent-soft); color: var(--accent); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab .key {
    display: inline-block; padding: 0 5px; font-size: 11px;
    background: var(--kbd-bg); border-radius: 3px; margin-left: 6px;
    font-family: ui-monospace, monospace; line-height: 16px;
  }
  .view { display: none; }
  .view.active { display: block; }

  /* Signup form */
  .signup-hero {
    max-width: 560px;
    margin: 1.5rem auto 0;
    text-align: center;
  }
  .signup-hero .label {
    display: block; font-weight: 600; font-size: 15px;
    margin-bottom: 0.5rem; text-align: left;
  }
  .signup-hero .account-name-wrap { position: relative; }
  #accountName {
    width: 100%; padding: 0.85rem 1rem;
    font: 600 18px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--input-bg); color: var(--fg);
    border: 2px solid var(--border-strong); border-radius: var(--radius);
    transition: border-color 0.12s, box-shadow 0.12s;
    text-align: left;
  }
  #accountName::placeholder { color: var(--muted-2); font-weight: 400; }
  #accountName:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #accountName.invalid { border-color: var(--error); box-shadow: 0 0 0 3px rgba(220, 53, 69, 0.12); }
  #accountName.valid { border-color: var(--success); }
  .field-error { color: var(--error); font-size: 12px; min-height: 16px; margin-top: 0.35rem; text-align: left; opacity: 0; transition: opacity 0.12s; }
  .field-error.show { opacity: 1; }
  .field-hint { color: var(--muted); font-size: 12px; margin-top: 0.4rem; text-align: left; }
  .field-hint kbd { display: inline-block; padding: 1px 5px; font-family: ui-monospace, monospace; background: var(--kbd-bg); border: 1px solid var(--kbd-border); border-radius: 3px; font-size: 11px; }
  .submit-btn {
    width: 100%; margin-top: 1rem; padding: 0.9rem 1.2rem;
    font: inherit; font-weight: 700; font-size: 16px;
    background: var(--accent); color: white;
    border: 0; border-radius: var(--radius); cursor: pointer;
    transition: background 0.12s, transform 0.05s;
  }
  .submit-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .submit-btn:active:not(:disabled) { transform: translateY(1px); }
  .submit-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .submit-btn:disabled { background: var(--muted-2); cursor: not-allowed; opacity: 0.6; }

  /* Advanced settings */
  details.advanced {
    max-width: 560px; margin: 1.5rem auto 0;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card-bg); overflow: hidden;
  }
  details.advanced > summary {
    cursor: pointer; font-weight: 600; padding: 0.75rem 1rem;
    list-style: none; user-select: none; color: var(--muted);
    display: flex; align-items: center; gap: 0.5rem;
    transition: background 0.12s, color 0.12s;
  }
  details.advanced > summary::-webkit-details-marker { display: none; }
  details.advanced > summary::before { content: "▸"; font-size: 10px; transition: transform 0.12s; color: var(--muted-2); }
  details.advanced[open] > summary::before { transform: rotate(90deg); }
  details.advanced > summary:hover { background: var(--accent-soft); color: var(--accent); }
  details.advanced > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  details.advanced > summary .count-hint { margin-left: auto; font-size: 11px; color: var(--muted-2); font-weight: 500; }
  .advanced-body { padding: 1rem; border-top: 1px solid var(--border); display: grid; gap: 1rem; }
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .field-grid > div { min-width: 0; }
  .field-grid .full { grid-column: 1 / -1; }
  label.field-label { display: block; font-weight: 500; font-size: 12px; margin-bottom: 0.25rem; color: var(--muted); }
  input[type="text"], input[type="password"], input[type="number"], input[type="search"], select {
    width: 100%; padding: 0.5rem 0.6rem; font: inherit;
    background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    box-sizing: border-box;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; margin: 0; }
  .toggle { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .toggle input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; flex: 0 0 auto; }
  .toggle label { margin: 0; font-weight: 400; cursor: pointer; font-size: 13px; }
  .hint-box { background: var(--info-bg); padding: 0.6rem 0.75rem; border-radius: var(--radius-sm); font-size: 12px; color: var(--fg); margin: 0; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-2); font-weight: 700; margin: 0.5rem 0 0.25rem; }
  .section-label:first-child { margin-top: 0; }

  /* Status + result */
  .status { padding: 0.6rem 0.9rem; border-radius: var(--radius-sm); margin: 1rem auto; max-width: 560px; white-space: pre-wrap; font-size: 13px; border: 1px solid transparent; }
  .status.info { background: var(--info-bg); border-color: rgba(0,0,0,0.05); }
  .status.error { background: var(--error-bg); }
  .status.success { background: var(--success-bg); }
  @media (prefers-color-scheme: dark) { .status.info { border-color: rgba(255,255,255,0.06); } }

  #result { max-width: 900px; margin: 1.5rem auto 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; }
  #result h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
  .pat { font-family: ui-monospace, "SF Mono", Consolas, monospace; background: var(--code-bg); padding: 0.5rem; border-radius: var(--radius-sm); word-break: break-all; user-select: all; font-size: 12px; border: 1px solid var(--border); }
  #result details { margin-top: 0.6rem; }
  #result details > summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 0.35rem 0; }
  pre { background: var(--code-bg); padding: 0.85rem; border-radius: var(--radius-sm); overflow: auto; max-height: 50vh; font-size: 12px; border: 1px solid var(--border); margin: 0.5rem 0 0; }

  /* Accounts view */
  .accounts-toolbar { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; flex-wrap: wrap; }
  .accounts-toolbar input[type="search"] { flex: 1; min-width: 200px; }
  .accounts-toolbar .count { color: var(--muted); font-size: 12px; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); padding: 0.45rem 0.85rem; border-radius: var(--radius-sm); cursor: pointer; font: inherit; font-weight: 600; transition: background 0.12s, color 0.12s; }
  button.secondary:hover:not(:disabled) { background: var(--accent); color: white; }
  button.secondary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.secondary:disabled { color: var(--muted-2); border-color: var(--border-strong); cursor: not-allowed; }
  button.danger { background: transparent; color: var(--error); border: 1px solid var(--error); padding: 0.45rem 0.85rem; border-radius: var(--radius-sm); cursor: pointer; font: inherit; font-weight: 600; transition: background 0.12s, color 0.12s; }
  button.danger:hover:not(:disabled) { background: var(--error); color: white; }

  .table-wrap { border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; max-height: 65vh; background: var(--card-bg); }
  table.accounts { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 780px; }
  table.accounts th, table.accounts td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
  table.accounts th { background: var(--th-bg); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; z-index: 1; }
  table.accounts th:hover { background: var(--accent-soft); }
  table.accounts tr.row { cursor: pointer; }
  table.accounts tr.row:hover { background: var(--hover-bg); }
  table.accounts tr.row.selected { background: var(--selected-bg); box-shadow: inset 3px 0 0 var(--accent); }
  table.accounts td.email { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px; word-break: break-all; }
  table.accounts td.user-id { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 11px; color: var(--muted); }
  table.accounts td.created { white-space: nowrap; color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: rgba(128,128,128,0.15); color: var(--fg); font-weight: 500; }
  .badge.ok { background: var(--success-bg); color: var(--success); }
  .badge.warn { background: rgba(255, 193, 7, 0.18); color: #856404; }
  @media (prefers-color-scheme: dark) { .badge.warn { color: #d4a857; } }
  .row-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; justify-content: flex-end; }
  .row-actions button { padding: 0.25rem 0.55rem; font-size: 11px; font-weight: 600; border-radius: 4px; }
  .row-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Import section */
  details.import-section { margin: 0 0 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card-bg); overflow: hidden; }
  details.import-section > summary { cursor: pointer; font-weight: 600; padding: 0.55rem 0.9rem; list-style: none; user-select: none; color: var(--muted); display: flex; align-items: center; gap: 0.5rem; font-size: 13px; transition: background 0.12s, color 0.12s; }
  details.import-section > summary::-webkit-details-marker { display: none; }
  details.import-section > summary::before { content: "▸"; font-size: 10px; transition: transform 0.12s; color: var(--muted-2); }
  details.import-section[open] > summary::before { transform: rotate(90deg); }
  details.import-section > summary:hover { background: var(--accent-soft); color: var(--accent); }
  details.import-section > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  details.import-section .count-hint { margin-left: auto; font-size: 11px; color: var(--muted-2); font-weight: 500; }
  .import-body { padding: 0.85rem 0.9rem; border-top: 1px solid var(--border); display: grid; gap: 0.85rem; }
  .import-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }
  @media (max-width: 720px) { .import-grid { grid-template-columns: 1fr; } }
  .import-single-row { display: flex; gap: 0.4rem; align-items: stretch; }
  .import-single-row input { flex: 1; min-width: 0; }
  .import-single-row button { white-space: nowrap; flex: 0 0 auto; }
  .import-batch-row { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.4rem; flex-wrap: wrap; }
  .import-batch-row .field-label { margin: 0; white-space: nowrap; }
  .import-batch-row select { width: auto; min-width: 130px; }
  .import-batch-row button { margin-left: auto; white-space: nowrap; }
  #import-results { margin-top: 0.2rem; font-size: 12px; font-family: ui-monospace, "SF Mono", Consolas, monospace; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.5rem 0.65rem; max-height: 240px; overflow: auto; }
  .import-result-line { padding: 1px 0; word-break: break-all; }
  .import-result-line.ok { color: var(--success); }
  .import-result-line.skip { color: var(--muted); }
  .import-result-line.err { color: var(--error); }
  textarea { width: 100%; padding: 0.55rem 0.65rem; font: inherit; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); box-sizing: border-box; resize: vertical; font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px; min-height: 80px; }
  textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

  /* Empty + loading */
  .empty { padding: 2rem; text-align: center; color: var(--muted); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; }

  /* Help modal */
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: none; align-items: center; justify-content: center; z-index: 100; padding: 1rem; backdrop-filter: blur(2px); }
  .overlay.open { display: flex; }
  .overlay-card { background: var(--card-bg); color: var(--fg); border-radius: var(--radius); padding: 1.5rem 1.75rem; max-width: 540px; width: 100%; box-shadow: var(--overlay-shadow); border: 1px solid var(--border); max-height: 90vh; overflow: auto; }
  .overlay-card h2 { margin: 0 0 1rem; font-size: 1.2rem; }
  .overlay-close { float: right; cursor: pointer; background: none; border: 0; font-size: 24px; line-height: 1; color: var(--muted); padding: 0 0.25rem; transition: color 0.12s; }
  .overlay-close:hover { color: var(--accent); }
  .shortcuts { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem 1rem; font-size: 13px; align-items: center; }
  .shortcuts kbd { display: inline-block; padding: 2px 7px; font-family: ui-monospace, monospace; background: var(--kbd-bg); border: 1px solid var(--kbd-border); border-radius: 3px; font-size: 11px; min-width: 18px; text-align: center; line-height: 16px; }

  /* Toast */
  .toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%) translateY(10px); background: #2a2a2a; color: white; padding: 0.6rem 1.1rem; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; opacity: 0; transition: opacity 0.2s, transform 0.2s; z-index: 200; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,0.25); max-width: 90vw; }
  .toast.show { opacity: 0.96; transform: translateX(-50%) translateY(0); }
  .toast.success { background: #1e7e34; }
  .toast.error { background: #b02a37; }

  /* Hint footer */
  .hint { color: var(--muted); font-size: 12px; margin: 1rem 0; line-height: 1.6; }
  .hint kbd { display: inline-block; padding: 1px 5px; font-family: ui-monospace, monospace; background: var(--kbd-bg); border: 1px solid var(--kbd-border); border-radius: 3px; font-size: 11px; }

  /* Header + info tooltip */
  .header-row { display: flex; align-items: center; gap: 0.5rem; }
  .info-tip { position: relative; display: inline-flex; align-items: center; justify-content: center; cursor: help; outline: none; }
  .info-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; font-size: 14px; font-weight: 700; line-height: 1; color: var(--muted); background: var(--kbd-bg); border: 1px solid var(--border-strong); border-radius: 50%; user-select: none; transition: color 0.12s, background 0.12s, border-color 0.12s; }
  .info-tip:hover .info-icon, .info-tip:focus-visible .info-icon { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .info-tip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 50%; }
  .info-tooltip { position: absolute; top: 100%; left: 50%; transform: translateX(-50%) translateY(6px); width: 340px; max-width: 80vw; background: #2a2a2a; color: white; padding: 0.65rem 0.85rem; border-radius: var(--radius-sm); font-size: 12px; line-height: 1.5; font-weight: 400; opacity: 0; pointer-events: none; transition: opacity 0.15s, transform 0.15s; z-index: 50; box-shadow: 0 6px 18px rgba(0,0,0,0.25); }
  .info-tooltip::before { content: ""; position: absolute; top: -5px; left: 50%; transform: translateX(-50%) rotate(45deg); width: 10px; height: 10px; background: #2a2a2a; }
  .info-tip:hover .info-tooltip, .info-tip:focus-within .info-tooltip { opacity: 0.97; transform: translateX(-50%) translateY(10px); }

  @media (max-width: 640px) {
    body { padding: 1rem 0.75rem 2rem; }
    .field-grid { grid-template-columns: 1fr; }
    .toggles { grid-template-columns: 1fr; }
    #result { padding: 0.85rem 1rem; }
    table.accounts { min-width: 580px; }
    .row-actions { flex-direction: column; align-items: stretch; }
    .row-actions button { width: 100%; }
    .signup-hero, details.advanced, .status { padding-left: 0.5rem; padding-right: 0.5rem; }
    .info-tooltip { width: 260px; }
  }
</style>
</head>
<body>
<div class="header-row">
  <h1>Supabase Onboarding Worker</h1>
  <span class="info-tip" tabindex="0" role="button" aria-label="What this worker does">
    <span class="info-icon" aria-hidden="true">ℹ</span>
    <span class="info-tooltip" role="tooltip">Sign up a brand-new Supabase account via the Chrome extension (hCaptcha), verify the email via the email worker, then create the platform profile, organization, and PAT. Steps 2-7 run server-side; only signup needs the extension.</span>
  </span>
</div>

<div class="ext-bar disconnected" id="ext-bar">
  <span class="ext-dot"></span>
  <span id="ext-status-text">Checking extension status…</span>
</div>

<div class="tabs" role="tablist">
  <button class="tab active" data-view="signup" role="tab" aria-selected="true">Signup <span class="key">1</span></button>
  <button class="tab" data-view="accounts" role="tab" aria-selected="false">Accounts <span class="key">2</span></button>
  <button class="tab" data-view="help" role="tab" aria-selected="false" style="margin-left:auto">Help <span class="key">?</span></button>
</div>

<!-- Signup view -->
<div id="signup-view" class="view active">
<form id="form">
  <div class="signup-hero">
    <label class="label" for="accountName">Account name</label>
    <div class="account-name-wrap">
      <input type="text" id="accountName" name="accountName"
             placeholder="e.g. johndoe → johndoe@privatimail.com"
             autofocus autocomplete="off" autocapitalize="off"
             spellcheck="false" autocorrect="off"
             aria-describedby="accountNameError accountNameHint">
    </div>
    <div class="field-error" id="accountNameError" role="alert" aria-live="polite"></div>
    <div class="field-hint" id="accountNameHint">
      3–30 chars · letters, digits, <code>.</code> <code>_</code> <code>-</code> only ·
      <kbd>Enter</kbd> to submit
    </div>
    <button type="submit" id="submit" class="submit-btn" disabled>Run pipeline</button>
  </div>

  <details class="advanced" id="advanced">
    <summary>
      <span>Advanced settings</span>
      <span class="count-hint" id="advanced-hint">all defaults</span>
    </summary>
    <div class="advanced-body">
      <div class="section-label">Identity</div>
      <div class="field-grid">
        <div>
          <label class="field-label" for="emailDomain">Email domain</label>
          <input type="text" id="emailDomain" name="emailDomain" value="privatimail.com" placeholder="privatimail.com">
        </div>
        <div>
          <label class="field-label" for="email">Email override (optional)</label>
          <input type="text" id="email" name="email" placeholder="user@example.com — overrides account name">
        </div>
        <div>
          <label class="field-label" for="password">Password (auto-gen if blank)</label>
          <input type="text" id="password" name="password" placeholder="auto-generate">
        </div>
        <div>
          <label class="field-label" for="orgName">Org name (defaults to email's Org)</label>
          <input type="text" id="orgName" name="orgName" placeholder="defaults to <email>'s Org">
        </div>
        <div>
          <label class="field-label" for="patName">PAT name</label>
          <input type="text" id="patName" name="patName" value="automation-token" placeholder="automation-token">
        </div>
        <div>
          <label class="field-label" for="patDays">PAT expiry (days)</label>
          <input type="number" id="patDays" name="patDays" value="30" min="1" max="365">
        </div>
      </div>
      <div class="section-label">Operations</div>
      <div class="toggles">
        <div class="toggle"><input type="checkbox" id="createOrg" checked><label for="createOrg">Create organization</label></div>
        <div class="toggle"><input type="checkbox" id="createPat" checked><label for="createPat">Generate PAT</label></div>
      </div>
      <p class="hint-box">Signup requires hCaptcha — the Chrome extension must be connected. After you click Run, the extension opens the Supabase signup page and you solve the captcha in your browser. The worker handles the rest (email verify → profile → org → PAT).</p>
    </div>
  </details>
</form>

<div class="status" id="status" style="display:none"></div>

<div id="result" style="display:none">
  <h2>Pipeline result</h2>
  <div id="result-summary"></div>
  <div id="pat-box" style="margin-top:0.75rem; display:none">
    <div style="font-size:12px; color:var(--muted); margin-bottom:0.25rem">PAT (Personal Access Token):</div>
    <div class="pat" id="pat"></div>
    <div style="margin-top:0.35rem"><button class="secondary" id="copy-pat">Copy PAT</button></div>
  </div>
  <div id="email-pw-box" style="margin-top:0.75rem; display:none">
    <div style="font-size:12px; color:var(--muted); margin-bottom:0.25rem">Credentials:</div>
    <div style="font-family:ui-monospace,monospace; font-size:12px; background:var(--code-bg); padding:0.5rem; border-radius:var(--radius-sm); border:1px solid var(--border);">
      Email: <span id="emailOut"></span>
      <button class="secondary" id="copy-email" style="padding:1px 6px; font-size:10px; margin-left:4px">copy</button><br>
      Password: <span id="passwordOut"></span>
      <button class="secondary" id="copy-password" style="padding:1px 6px; font-size:10px; margin-left:4px">copy</button>
    </div>
  </div>
  <details><summary>Full JSON response</summary><pre id="json"></pre></details>
</div>
</div>

<!-- Accounts view -->
<div id="accounts-view" class="view">
<div class="accounts-toolbar">
  <input type="search" id="accounts-search" placeholder="Search by email, user ID, or org…">
  <button class="secondary" id="accounts-refresh">Refresh <span class="key" style="background:var(--kbd-bg); padding:0 4px; border-radius:3px; font-size:10px; margin-left:2px">r</span></button>
  <span class="count" id="accounts-count"></span>
</div>
<div class="status" id="accounts-status" style="display:none"></div>

<details class="import-section">
  <summary>
    <span>Import accounts</span>
    <span class="count-hint">single PAT or batch JSON/CSV</span>
  </summary>
  <div class="import-body">
    <div class="import-grid">
      <div>
        <label class="field-label">Single PAT import</label>
        <div class="import-single-row">
          <input type="text" id="import-single-pat" placeholder="sbp_...">
          <button class="secondary" id="import-single-btn">Import</button>
        </div>
      </div>
      <div>
        <label class="field-label">Batch import</label>
        <div class="import-batch-row">
          <select id="import-format">
            <option value="auto" selected>auto</option>
            <option value="json">JSON</option>
            <option value="csv">CSV / one-per-line</option>
          </select>
          <button class="secondary" id="import-batch-btn">Import batch</button>
        </div>
      </div>
    </div>
    <textarea id="import-batch-text" placeholder='Batch: one PAT per line, or JSON array ["sbp_...", "sbp_..."]'></textarea>
    <div id="import-results" style="display:none"></div>
  </div>
</details>

<div class="table-wrap">
  <table class="accounts">
    <thead>
      <tr>
        <th>Email</th>
        <th>User ID</th>
        <th>Org</th>
        <th>Plan</th>
        <th>Status</th>
        <th>Created</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="accounts-tbody"></tbody>
  </table>
</div>

<p class="hint">
  Tip: <kbd>j</kbd>/<kbd>k</kbd> or arrow keys to navigate · <kbd>Enter</kbd> to open reset link ·
  <kbd>c</kbd> to copy PAT · <kbd>r</kbd> to refresh · <kbd>?</kbd> for full list.
</p>
</div>

<!-- Help modal -->
<div class="overlay" id="help-overlay" role="dialog" aria-modal="true" aria-labelledby="help-title">
  <div class="overlay-card">
    <button class="overlay-close" id="help-close" aria-label="Close">×</button>
    <h2 id="help-title">Keyboard shortcuts</h2>
    <div class="shortcuts">
      <div>Toggle this help</div><div><kbd>?</kbd></div>
      <div>Signup view</div><div><kbd>1</kbd> or <kbd>s</kbd></div>
      <div>Accounts view</div><div><kbd>2</kbd> or <kbd>a</kbd></div>
      <div>Focus search (jumps to Accounts)</div><div><kbd>/</kbd></div>
      <div>New signup (focus account name)</div><div><kbd>n</kbd></div>
      <div>Refresh accounts list</div><div><kbd>r</kbd></div>
      <div>Move selection down</div><div><kbd>j</kbd> or <kbd>↓</kbd></div>
      <div>Move selection up</div><div><kbd>k</kbd> or <kbd>↑</kbd></div>
      <div>Open reset link for selected</div><div><kbd>Enter</kbd></div>
      <div>Copy PAT for selected</div><div><kbd>c</kbd></div>
      <div>Delete selected account</div><div><kbd>d</kbd></div>
      <div>Close overlay / clear selection</div><div><kbd>Esc</kbd></div>
    </div>
    <p class="hint" style="margin-top:1rem">
      <kbd>1</kbd>/<kbd>2</kbd> work even in input fields; <kbd>s</kbd>/<kbd>a</kbd> only work outside inputs. Other shortcuts are disabled while typing in inputs, except <kbd>Esc</kbd> and <kbd>Enter</kbd>.
    </p>
  </div>
</div>

<!-- Confirm modal -->
<div class="overlay" id="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
  <div class="overlay-card" style="max-width:440px">
    <h2 id="confirm-title" style="font-size:1.05rem">Confirm</h2>
    <p id="confirm-body" style="margin:0.5rem 0 1.25rem;font-size:14px"></p>
    <div style="display:flex;gap:0.5rem;justify-content:flex-end">
      <button type="button" class="secondary" id="confirm-cancel">Cancel</button>
      <button type="button" id="confirm-ok" class="submit-btn" style="width:auto;margin-top:0;padding:0.5rem 1.2rem;font-size:14px">Confirm</button>
    </div>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
// Element refs
const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const jsonEl = document.getElementById("json");
const patEl = document.getElementById("pat");
const patBox = document.getElementById("pat-box");
const submitBtn = document.getElementById("submit");
const emailOut = document.getElementById("emailOut");
const passwordOut = document.getElementById("passwordOut");
const emailPwBox = document.getElementById("email-pw-box");
const accountNameInput = document.getElementById("accountName");
const accountNameError = document.getElementById("accountNameError");
const advancedEl = document.getElementById("advanced");
const advancedHint = document.getElementById("advanced-hint");
const extBar = document.getElementById("ext-bar");
const extStatusText = document.getElementById("ext-status-text");

const tabs = Array.from(document.querySelectorAll(".tab"));
const views = {
  signup: document.getElementById("signup-view"),
  accounts: document.getElementById("accounts-view"),
};
const accountsTbody = document.getElementById("accounts-tbody");
const accountsSearch = document.getElementById("accounts-search");
const accountsRefresh = document.getElementById("accounts-refresh");
const accountsCount = document.getElementById("accounts-count");
const accountsStatus = document.getElementById("accounts-status");
const helpOverlay = document.getElementById("help-overlay");
const helpClose = document.getElementById("help-close");
const confirmOverlay = document.getElementById("confirm-overlay");
const confirmBody = document.getElementById("confirm-body");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");
const toastEl = document.getElementById("toast");

let currentView = "signup";
let allAccounts = [];
let filteredAccounts = [];
let selectedIndex = -1;
let accountsLoaded = false;
let confirmResolve = null;
let pollJobTimer = null;

// Toast
let toastTimer = null;
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (kind ? " " + kind : "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast" + (kind ? " " + kind : ""); }, 2400);
}

function setStatus(cls, msg) {
  statusEl.style.display = "block";
  statusEl.className = "status " + cls;
  statusEl.textContent = msg;
}
function setAccountsStatus(cls, msg) {
  if (!msg) { accountsStatus.style.display = "none"; return; }
  accountsStatus.style.display = "block";
  accountsStatus.className = "status " + cls;
  accountsStatus.textContent = msg;
}

// Confirm dialog
function confirmDialog(message, okText) {
  return new Promise((resolve) => {
    confirmBody.textContent = message;
    confirmOk.textContent = okText || "Confirm";
    confirmOverlay.classList.add("open");
    confirmResolve = resolve;
    setTimeout(() => confirmOk.focus(), 0);
  });
}
function closeConfirm(value) {
  confirmOverlay.classList.remove("open");
  if (confirmResolve) { confirmResolve(value); confirmResolve = null; }
}
confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) closeConfirm(false); });

// Account name validation
function validateAccountName(v) {
  if (!v) return "Account name is required.";
  if (v.length < 3) return "Must be at least 3 characters.";
  if (v.length > 30) return "Must be at most 30 characters.";
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) return "Only letters, digits, '.', '_', '-' are allowed.";
  if (/^[.-]/.test(v) || /[.-]$/.test(v)) return "Cannot start or end with '.' or '-'.";
  if (/\\.\\./.test(v) || /--/.test(v)) return "Cannot have consecutive '.' or '-'.";
  return null;
}
function updateAccountNameValidation() {
  const v = accountNameInput.value;
  const err = validateAccountName(v);
  const empty = v.length === 0;
  if (err) {
    accountNameInput.classList.add("invalid");
    accountNameInput.classList.remove("valid");
    accountNameError.textContent = err;
    accountNameError.classList.add("show");
    submitBtn.disabled = true;
  } else if (empty) {
    accountNameInput.classList.remove("invalid", "valid");
    accountNameError.textContent = "";
    accountNameError.classList.remove("show");
    submitBtn.disabled = true;
  } else {
    accountNameInput.classList.remove("invalid");
    accountNameInput.classList.add("valid");
    accountNameError.textContent = "";
    accountNameError.classList.remove("show");
    submitBtn.disabled = false;
  }
}
accountNameInput.addEventListener("input", updateAccountNameValidation);
accountNameInput.addEventListener("blur", () => {
  if (accountNameInput.value.length === 0) {
    accountNameInput.classList.add("invalid");
    accountNameError.textContent = "Account name is required.";
    accountNameError.classList.add("show");
  }
});
updateAccountNameValidation();

// Advanced hint
function updateAdvancedHint() {
  let changes = 0;
  if (form.emailDomain.value && form.emailDomain.value !== "privatimail.com") changes++;
  if (form.email.value) changes++;
  if (form.password.value) changes++;
  if (form.orgName.value) changes++;
  if (form.patName.value && form.patName.value !== "automation-token") changes++;
  if (form.patDays.value !== "30") changes++;
  if (!form.createOrg.checked) changes++;
  if (!form.createPat.checked) changes++;
  advancedHint.textContent = changes === 0 ? "all defaults" : changes + " customized";
}
advancedEl.addEventListener("input", updateAdvancedHint);
advancedEl.addEventListener("change", updateAdvancedHint);
updateAdvancedHint();

// View switching
function switchView(name) {
  if (name === "help") { toggleHelp(); return; }
  if (!views[name]) return;
  currentView = name;
  tabs.forEach(t => {
    const active = t.dataset.view === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("active", k === name));
  if (name === "accounts" && !accountsLoaded) refreshAccounts();
  if (name === "signup") setTimeout(() => accountNameInput.focus(), 0);
}
tabs.forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
tabs.forEach((t, i) => {
  t.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); tabs[(i + 1) % tabs.length].focus(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); tabs[(i - 1 + tabs.length) % tabs.length].focus(); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); t.click(); }
  });
});

// Help overlay
function toggleHelp() { helpOverlay.classList.toggle("open"); }
function closeHelp() { helpOverlay.classList.remove("open"); }
helpClose.addEventListener("click", closeHelp);
helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) closeHelp(); });

// Extension status
async function checkExtension() {
  try {
    const r = await fetch("/api/extensions");
    const data = await r.json();
    const exts = data.extensions || [];
    if (exts.length > 0) {
      extBar.className = "ext-bar connected";
      extStatusText.textContent = "✓ " + exts.length + " extension(s) connected — " + exts.map(e => e.agentId + " (" + e.commandCount + " cmds)").join(", ");
    } else {
      extBar.className = "ext-bar disconnected";
      extStatusText.textContent = "✗ No extension connected — load the Chrome extension and connect to wss://" + location.host + "/ws";
    }
  } catch (e) {
    extBar.className = "ext-bar disconnected";
    extStatusText.textContent = "✗ Cannot reach worker: " + e.message;
  }
}
checkExtension();
setInterval(checkExtension, 10000);

// Form submission
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = validateAccountName(accountNameInput.value);
  if (err) {
    accountNameInput.classList.add("invalid");
    accountNameError.textContent = err;
    accountNameError.classList.add("show");
    accountNameInput.focus();
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "Running…";
  resultEl.style.display = "none";

  const body = {
    email: form.email.value || (form.accountName.value + "@" + (form.emailDomain.value || "privatimail.com")),
    password: form.password.value || undefined,
    orgName: form.orgName.value || undefined,
    patName: form.patName.value || undefined,
    patExpiresInDays: parseInt(form.patDays.value, 10) || 30,
    createOrg: form.createOrg.checked,
    createPat: form.createPat.checked,
  };

  setStatus("info", "Starting pipeline — the extension will open the signup page. Solve the hCaptcha in your browser. The worker handles the rest (email verify → profile → org → PAT)…");

  try {
    const r = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    jsonEl.textContent = JSON.stringify(data, null, 2);
    if (r.status === 202) {
      setStatus("info", "Job " + data.jobId.slice(0, 8) + " running for " + data.email + ". Password: " + data.password + ". Solve the hCaptcha in your browser…");
      pollJob(data.jobId, data.password);
    } else {
      setStatus("error", "✗ " + (data.error || "Pipeline failed"));
      resultEl.style.display = "block";
    }
  } catch (e) {
    setStatus("error", "✗ Network error: " + e.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Run pipeline";
    updateAccountNameValidation();
  }
});

async function pollJob(jobId, password) {
  if (pollJobTimer) clearInterval(pollJobTimer);
  pollJobTimer = setInterval(async () => {
    try {
      const r = await fetch("/api/jobs");
      const data = await r.json();
      const job = (data.jobs || []).find(j => j.id === jobId);
      if (!job) return;
      jsonEl.textContent = JSON.stringify(JSON.parse(job.result || job.error || "{}"), null, 2);
      if (job.status === "completed") {
        clearInterval(pollJobTimer); pollJobTimer = null;
        const result = JSON.parse(job.result || "{}");
        const pat = result.pat || result.steps?.find(s => s.step === "pat")?.pat;
        document.getElementById("result-summary").innerHTML =
          "✓ Pipeline complete for " + result.email + "<br>" +
          "User ID: " + result.userId + "<br>" +
          "Org: " + result.orgName + " (slug: " + result.orgSlug + ")<br>" +
          "Plan: " + (result.planId || "free");
        if (pat) { patEl.textContent = pat; patBox.style.display = "block"; }
        emailOut.textContent = result.email || "";
        passwordOut.textContent = password || "";
        emailPwBox.style.display = "block";
        resultEl.style.display = "block";
        setStatus("success", "✓ Pipeline complete! PAT: " + (pat || "(none)").slice(0, 30) + "…");
        accountsLoaded = false;
      } else if (job.status === "failed") {
        clearInterval(pollJobTimer); pollJobTimer = null;
        setStatus("error", "✗ Pipeline failed: " + job.error);
        resultEl.style.display = "block";
      }
    } catch (e) {}
  }, 5000);
}

// Copy buttons
function copyText(text, okMsg) {
  if (!text) { toast("✗ Nothing to copy", "error"); return; }
  navigator.clipboard.writeText(text).then(() => toast(okMsg, "success")).catch(e => toast("✗ Copy failed: " + e.message, "error"));
}
document.getElementById("copy-pat").addEventListener("click", () => copyText(patEl.textContent, "✓ PAT copied"));
document.getElementById("copy-email").addEventListener("click", () => copyText(emailOut.textContent, "✓ Email copied"));
document.getElementById("copy-password").addEventListener("click", () => copyText(passwordOut.textContent, "✓ Password copied"));

// Accounts view
async function refreshAccounts() {
  accountsLoaded = true;
  accountsTbody.innerHTML = '<tr><td colspan="7" class="empty"><span class="spinner"></span> Loading accounts…</td></tr>';
  accountsCount.textContent = "";
  setAccountsStatus("");
  try {
    const r = await fetch("/api/accounts");
    const data = await r.json();
    allAccounts = data.accounts || [];
    applySearchFilter();
  } catch (e) {
    allAccounts = [];
    accountsTbody.innerHTML = '<tr><td colspan="7" class="empty">✗ Network error: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function applySearchFilter() {
  const q = accountsSearch.value.trim().toLowerCase();
  filteredAccounts = !q ? allAccounts : allAccounts.filter(a =>
    (a.email || "").toLowerCase().includes(q) ||
    (a.user_id || "").toLowerCase().includes(q) ||
    (a.org_name || "").toLowerCase().includes(q)
  );
  if (selectedIndex >= filteredAccounts.length) selectedIndex = filteredAccounts.length - 1;
  if (selectedIndex < -1) selectedIndex = -1;
  renderAccounts();
}

function fmtRelative(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const diff = Math.max(0, Date.now() - d.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.floor(hr / 24);
  if (day < 30) return day + "d ago";
  return Math.floor(day / 30) + "mo ago";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderAccounts() {
  accountsCount.textContent = filteredAccounts.length === allAccounts.length
    ? filteredAccounts.length + " account" + (filteredAccounts.length === 1 ? "" : "s")
    : filteredAccounts.length + " of " + allAccounts.length;
  if (filteredAccounts.length === 0) {
    accountsTbody.innerHTML = '<tr><td colspan="7" class="empty">' +
      (allAccounts.length === 0 ? "No onboarded accounts yet. Run a signup to create one." : "No accounts match your search.") + '</td></tr>';
    return;
  }
  const rows = filteredAccounts.map((a, i) => {
    const selected = i === selectedIndex ? " selected" : "";
    return '<tr class="row' + selected + '" data-index="' + i + '" data-email="' + escapeHtml(a.email || "") + '">' +
      '<td class="email">' + escapeHtml(a.email || "") + '</td>' +
      '<td class="user-id">' + escapeHtml((a.user_id || "").slice(0, 12)) + (a.user_id ? '…' : '') + '</td>' +
      '<td>' + escapeHtml(a.org_name || "—") + '</td>' +
      '<td><span class="badge ok">' + escapeHtml(a.plan_id || "free") + '</span></td>' +
      '<td><span class="badge ' + (a.status === "complete" ? "ok" : a.status === "failed" ? "warn" : "") + '">' + escapeHtml(a.status || "—") + '</span></td>' +
      '<td class="created" title="' + escapeHtml(new Date(a.created_at).toISOString()) + '">' + fmtRelative(a.created_at) + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="secondary" data-act="copy-pat" title="Copy PAT (c)">Copy PAT</button>' +
        '<button class="secondary" data-act="relogin" title="Send password reset">Re-login</button>' +
        '<button class="danger" data-act="delete" title="Delete (d)">Del</button>' +
      '</div></td>' +
    '</tr>';
  }).join("");
  accountsTbody.innerHTML = rows;
}

accountsTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    e.stopPropagation();
    const tr = btn.closest("tr");
    const idx = parseInt(tr.dataset.index, 10);
    const a = filteredAccounts[idx];
    if (!a) return;
    const act = btn.dataset.act;
    if (act === "copy-pat") await copyPatForAccount(a);
    else if (act === "relogin") await reloginAccount(a);
    else if (act === "delete") await deleteAccount(a);
    return;
  }
  const tr = e.target.closest("tr.row");
  if (!tr) return;
  selectedIndex = parseInt(tr.dataset.index, 10);
  renderAccounts();
});

accountsSearch.addEventListener("input", applySearchFilter);
accountsRefresh.addEventListener("click", refreshAccounts);

// Account actions
async function copyPatForAccount(summary) {
  try {
    const r = await fetch("/api/accounts/" + encodeURIComponent(summary.email) + "/pat");
    const data = await r.json();
    if (!data.account || !data.account.pat) { toast("✗ No PAT available", "error"); return; }
    await navigator.clipboard.writeText(data.account.pat);
    toast("✓ PAT copied to clipboard", "success");
  } catch (e) { toast("✗ Copy failed: " + e.message, "error"); }
}

async function reloginAccount(summary) {
  const ok = await confirmDialog("Send password reset email for " + summary.email + "?");
  if (!ok) return;
  setAccountsStatus("info", "Sending password reset email…");
  try {
    const r = await fetch("/api/accounts/" + encodeURIComponent(summary.email) + "/relogin", { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      setAccountsStatus("success", "✓ " + data.note);
      if (data.resetLink) toast("Reset link: " + data.resetLink.slice(0, 60) + "…", "success");
    } else {
      setAccountsStatus("error", "✗ " + (data.error || data.note || "Failed"));
    }
  } catch (e) { setAccountsStatus("error", "✗ " + e.message); }
}

async function deleteAccount(summary) {
  const ok = await confirmDialog("Delete account " + summary.email + "? This removes it from D1 only (the Supabase account remains).");
  if (!ok) return;
  try {
    await fetch("/api/accounts/" + encodeURIComponent(summary.email), { method: "DELETE" });
    toast("✓ Deleted", "success");
    refreshAccounts();
  } catch (e) { toast("✗ Delete failed: " + e.message, "error"); }
}

// Import
const importSinglePat = document.getElementById("import-single-pat");
const importSingleBtn = document.getElementById("import-single-btn");
const importBatchText = document.getElementById("import-batch-text");
const importFormat = document.getElementById("import-format");
const importBatchBtn = document.getElementById("import-batch-btn");
const importResults = document.getElementById("import-results");

async function importSingle() {
  const pat = (importSinglePat.value || "").trim();
  if (!pat) { toast("✗ Paste a PAT first", "error"); return; }
  importSingleBtn.disabled = true;
  importSingleBtn.innerHTML = '<span class="row-spinner"></span> Importing…';
  try {
    const r = await fetch("/api/accounts/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pat, email: pat }) });
    const data = await r.json();
    if (data.ok) { toast("✓ Imported", "success"); importSinglePat.value = ""; refreshAccounts(); }
    else toast("✗ Import failed: " + (data.error || ""), "error");
  } catch (e) { toast("✗ Network error: " + e.message, "error"); }
  importSingleBtn.disabled = false;
  importSingleBtn.textContent = "Import";
}
importSingleBtn.addEventListener("click", importSingle);
importSinglePat.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); importSingle(); } });

async function importBatch() {
  const raw = importBatchText.value.trim();
  if (!raw) { toast("✗ Nothing to import", "error"); return; }
  let payload;
  const fmt = importFormat.value;
  if (fmt === "json" || (fmt === "auto" && (raw.startsWith("[") || raw.startsWith("{")))) {
    try { payload = JSON.parse(raw); } catch (e) { toast("✗ Invalid JSON: " + e.message, "error"); return; }
  } else {
    payload = { csv: raw };
  }
  importBatchBtn.disabled = true;
  importBatchBtn.innerHTML = '<span class="row-spinner"></span> Importing…';
  try {
    const r = await fetch("/api/accounts/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await r.json();
    toast("✓ Import complete", "success");
    refreshAccounts();
  } catch (e) { toast("✗ Network error: " + e.message, "error"); }
  importBatchBtn.disabled = false;
  importBatchBtn.textContent = "Import batch";
}
importBatchBtn.addEventListener("click", importBatch);

// Selection navigation
function moveSelection(delta) {
  if (filteredAccounts.length === 0) return;
  selectedIndex = Math.max(-1, Math.min(filteredAccounts.length - 1, selectedIndex + delta));
  renderAccounts();
  const tr = accountsTbody.querySelector('tr.row[data-index="' + selectedIndex + '"]');
  if (tr) tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function clearSelection() { selectedIndex = -1; renderAccounts(); }
function selectedAccount() { return selectedIndex >= 0 ? filteredAccounts[selectedIndex] : null; }

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const tag = t.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;

  if (e.key === "Escape") {
    if (helpOverlay.classList.contains("open")) { closeHelp(); return; }
    if (confirmOverlay.classList.contains("open")) { closeConfirm(false); return; }
    if (isInput) { t.blur(); return; }
    if (selectedIndex >= 0) { clearSelection(); return; }
    return;
  }

  if (e.key === "Enter") {
    if (isInput && t.id === "accounts-search") {
      e.preventDefault();
      const a = selectedAccount();
      if (a) reloginAccount(a);
      return;
    }
    if (!isInput) {
      const a = selectedAccount();
      if (a) { e.preventDefault(); reloginAccount(a); }
    }
    return;
  }

  if (e.key === "1" || e.key === "2") {
    if (isInput && t.id === "accounts-search") return;
    e.preventDefault();
    if (isInput) t.blur();
    switchView(e.key === "1" ? "signup" : "accounts");
    return;
  }
  if (!isInput) {
    if (e.key === "s" || e.key === "S") { e.preventDefault(); switchView("signup"); return; }
    if (e.key === "a" || e.key === "A") { e.preventDefault(); switchView("accounts"); return; }
  }
  if (isInput) return;

  switch (e.key) {
    case "?": e.preventDefault(); toggleHelp(); break;
    case "/": e.preventDefault(); switchView("accounts"); accountsSearch.focus(); accountsSearch.select(); break;
    case "n": e.preventDefault(); switchView("signup"); accountNameInput.focus(); accountNameInput.select(); break;
    case "r": e.preventDefault(); refreshAccounts(); break;
    case "j": case "ArrowDown": e.preventDefault(); if (currentView !== "accounts") switchView("accounts"); moveSelection(1); break;
    case "k": case "ArrowUp": e.preventDefault(); if (currentView !== "accounts") switchView("accounts"); moveSelection(-1); break;
    case "c": { e.preventDefault(); const a = selectedAccount(); if (a) copyPatForAccount(a); else toast("No account selected", "error"); break; }
    case "d": { e.preventDefault(); const a = selectedAccount(); if (a) deleteAccount(a); else toast("No account selected", "error"); break; }
  }
});

// Init
if (document.readyState !== "loading") accountNameInput.focus();
else window.addEventListener("DOMContentLoaded", () => accountNameInput.focus());
</script>
</body>
</html>`;
}
