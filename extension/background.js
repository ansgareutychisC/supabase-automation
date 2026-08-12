/**
 * Supabase Onboarding Bridge — Background Service Worker
 *
 * This extension is a DUMB INTERACTION PROXY. It contains ZERO business logic.
 * It connects to the Python backend via WebSocket and executes commands from
 * the real browser context. All intelligence lives on the Python side.
 *
 * Protocol:
 *   Server → Extension:
 *     {type: 'fetch', id, url, method, headers, body, credentials, timeoutMs}
 *     {type: 'tabs.open', id, url, active}
 *     {type: 'tabs.close', id, tabId}
 *     {type: 'tabs.list', id}
 *     {type: 'tabs.focus', id, tabId}
 *     {type: 'form.fill', id, tabId, selector, value}
 *     {type: 'form.click', id, tabId, selector}
 *     {type: 'form.wait', id, tabId, selector, timeoutMs}
 *     {type: 'form.eval', id, tabId, function, args}
 *     {type: 'xhr.intercept', id, tabId, urlPattern, method, timeoutMs}
 *     {type: 'cookies.get', id, url, name}
 *     {type: 'cookies.getAll', id, url}
 *     {type: 'cookies.set', id, url, cookies}
 *     {type: 'screenshot', id, tabId}
 *     {type: 'ping'}
 *
 *   Extension → Server:
 *     {type: 'auth', token}
 *     {type: 'connect', agentId, userAgent, hostname}
 *     {type: 'result', id, ok, status, body, headers, finalUrl, error}
 *     {type: 'xhr.event', id, method, url, status, requestBody, responseBody, requestHeaders, responseHeaders}
 *     {type: 'pong'}
 *     {type: 'log', level, message, data}
 *
 * Debuggability:
 *   - Every command received is logged to console + popup + server
 *   - Every result sent is logged with full context
 *   - XHR interceptions include request body + response body + headers
 *   - The popup shows a live activity feed
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let keepaliveInterval = null;

const state = {
  status: 'disconnected',  // disconnected | connecting | connected | error
  serverUrl: '',
  authToken: '',
  agentId: 'ext-' + Math.random().toString(36).slice(2, 8),
  connectedAt: null,
  lastError: null,
  commandsReceived: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
  lastCommandAt: null,
  log: [],
  // XHR interception state: {interceptId: {urlPattern, method, tabId, resolve}}
  interceptors: new Map(),
  // Pending command promises: {commandId: resolve}
  pending: new Map(),
};

const MAX_LOG = 200;

// ---------------------------------------------------------------------------
// Logging — both to console, popup, and server
// ---------------------------------------------------------------------------

function log(level, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    data: data || undefined,
  };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[supabase-bridge] ${message}`, data || '');

  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();

  // Send to server (best-effort)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'log', level, message, data }));
    } catch (e) { /* ignore */ }
  }

  // Notify popup if open
  try { chrome.runtime.sendMessage({ type: 'log', entry }); } catch (e) { /* popup not open */ }
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'autoConnect', 'authToken']);
  return {
    serverUrl: cfg.serverUrl || 'ws://localhost:8787',
    autoConnect: cfg.autoConnect !== false,
    authToken: cfg.authToken || '',
  };
}

async function saveConfig(patch) {
  await chrome.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function buildWsUrl(rawUrl) {
  let url = rawUrl.trim().replace(/\/+$/, '');
  // Convert http(s):// to ws(s)://
  if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
  else if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
  // Add ws:// prefix if no scheme
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;

  const parsed = new URL(url);

  // If connecting to localhost/127.0.0.1, no need for XTransformPort
  // (direct connection to the bridge, not through Caddy)
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0';

  // For remote connections through the Caddy gateway, add XTransformPort=8787
  // so Caddy routes the request to localhost:8787 where the bridge listens.
  if (!isLocal && !parsed.searchParams.has('XTransformPort')) {
    parsed.searchParams.set('XTransformPort', '8787');
  }

  // WebSocket path MUST be "/" — Caddy's XTransformPort routing only
  // upgrades WebSocket connections when the path is "/". This matches
  // the brand-studio extension pattern.
  parsed.pathname = '/';

  return parsed.toString();
}

async function connect(rawUrl) {
  if (state.status === 'connecting' || state.status === 'connected') {
    log('warn', 'already connected or connecting');
    return;
  }

  const url = buildWsUrl(rawUrl);
  state.serverUrl = rawUrl;
  state.status = 'connecting';
  state.lastError = null;
  broadcastStatus();

  log('info', 'connecting', { url });

  try {
    ws = new WebSocket(url);
  } catch (err) {
    state.status = 'error';
    state.lastError = err.message;
    log('error', 'connect-failed', { error: err.message });
    broadcastStatus();
    return;
  }

  ws.onopen = () => {
    state.status = 'connected';
    state.connectedAt = Date.now();
    state.lastError = null;
    log('info', 'ws-connected', { url });

    // Stop HTTP fallback polling — WS is alive now
    stopHttpPolling();

    // Send auth + connect messages
    ws.send(JSON.stringify({ type: 'auth', token: state.authToken || '' }));
    ws.send(JSON.stringify({
      type: 'connect',
      agentId: state.agentId,
      userAgent: navigator.userAgent,
      hostname: 'chrome-extension',
    }));

    // Keepalive ping every 25s (MV3 service workers die after 30s of inactivity)
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } else {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
    }, 25000);

    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      log('warn', 'invalid-message', { raw: event.data.slice(0, 200) });
      return;
    }
    await handleCommand(msg);
  };

  ws.onerror = (event) => {
    state.status = 'error';
    state.lastError = 'WebSocket error (check server URL and network)';
    log('error', 'ws-error', { event: String(event) });
    broadcastStatus();
  };

  ws.onclose = (event) => {
    state.status = 'disconnected';
    state.connectedAt = null;
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    log('info', 'disconnected', { code: event.code, reason: event.reason });
    broadcastStatus();

    // Start HTTP fallback polling immediately (SOS satellite mode)
    // This keeps the extension functional even if WS reconnection fails
    startHttpPolling();

    // Auto-reconnect WebSocket after 5s
    if (event.code !== 1000 && state.serverUrl) {
      log('info', 'auto-reconnect-in-5s');
      setTimeout(async () => {
        const cfg = await loadConfig();
        if (cfg.autoConnect && state.serverUrl) {
          connect(state.serverUrl);
        }
      }, 5000);
    }
  };
}

function disconnect() {
  state.serverUrl = '';
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  if (ws) {
    ws.close(1000, 'user disconnect');
    ws = null;
  }
  state.status = 'disconnected';
  state.connectedAt = null;
  broadcastStatus();
  log('info', 'disconnected-by-user');
}

// ---------------------------------------------------------------------------
// Send result back to server (via WebSocket or HTTP fallback)
// ---------------------------------------------------------------------------

function sendResult(id, result) {
  const msg = { type: 'result', id, ...result };
  // Try WebSocket first
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    state.commandsCompleted++;
    log('debug', 'result-sent-ws', { id, ok: result.ok });
  } else {
    // HTTP fallback: POST /api/result
    sendResultHttp(msg);
  }
  broadcastStatus();
}

async function sendResultHttp(msg) {
  try {
    const cfg = await loadConfig();
    const httpUrl = cfg.serverUrl
      .replace(/^ws/, 'http')
      .replace(/\/ws$/, '') + '/api/result';
    const r = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (r.ok) {
      state.commandsCompleted++;
      log('debug', 'result-sent-http', { id: msg.id });
    } else {
      log('error', 'result-http-failed', { id: msg.id, status: r.status });
    }
  } catch (e) {
    log('error', 'result-http-error', { id: msg.id, error: e.message });
  }
}

function sendError(id, error) {
  state.commandsFailed++;
  log('error', 'command-failed', { id, error });
  sendResult(id, { ok: false, error: String(error) });
  broadcastStatus();
}

// ---------------------------------------------------------------------------
// HTTP fallback polling (SOS satellite mode)
// When WebSocket can't stay alive (MV3 service worker died, network blocks WS),
// the extension falls back to long-polling GET /api/poll for commands.
// ---------------------------------------------------------------------------

let httpPollActive = false;

async function startHttpPolling() {
  if (httpPollActive) return;
  httpPollActive = true;
  log('info', 'http-poll-start');

  while (httpPollActive) {
    try {
      const cfg = await loadConfig();
      if (!cfg.serverUrl) break;
      const httpUrl = cfg.serverUrl
        .replace(/^ws/, 'http')
        .replace(/\/ws$/, '') + '/api/poll?agentId=' + state.agentId + '&wait=25';

      const r = await fetch(httpUrl, { method: 'GET' });
      if (r.ok) {
        const data = await r.json();
        const commands = data.commands || [];
        for (const cmd of commands) {
          // Update connection status — we're alive via HTTP
          if (state.status !== 'connected') {
            state.status = 'connected-http';
            state.connectedAt = Date.now();
            broadcastStatus();
          }
          log('info', 'http-cmd-received', { type: cmd.type, id: cmd.id });
          state.commandsReceived++;
          broadcastStatus();
          await handleCommand(cmd);
        }
      }
    } catch (e) {
      log('warn', 'http-poll-error', { error: e.message });
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  httpPollActive = false;
  log('info', 'http-poll-stop');
}

function stopHttpPolling() {
  httpPollActive = false;
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  if (msg.type === 'ping') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    }
    return;
  }

  if (!msg.id) {
    log('warn', 'command-missing-id', { type: msg.type });
    return;
  }

  state.commandsReceived++;
  state.lastCommandAt = Date.now();
  log('info', 'command-received', { id: msg.id, type: msg.type, ...('url' in msg ? { url: msg.url } : {}) });
  broadcastStatus();

  try {
    switch (msg.type) {
      case 'fetch':
        await handleFetch(msg);
        break;
      case 'page.fetch':
        await handlePageFetch(msg);
        break;
      case 'tabs.open':
        await handleTabsOpen(msg);
        break;
      case 'tabs.close':
        await handleTabsClose(msg);
        break;
      case 'tabs.list':
        await handleTabsList(msg);
        break;
      case 'tabs.focus':
        await handleTabsFocus(msg);
        break;
      case 'form.fill':
        await handleFormFill(msg);
        break;
      case 'form.click':
        await handleFormClick(msg);
        break;
      case 'form.wait':
        await handleFormWait(msg);
        break;
      case 'form.eval':
        await handleFormEval(msg);
        break;
      case 'xhr.intercept':
        await handleXhrIntercept(msg);
        break;
      case 'cookies.get':
        await handleCookiesGet(msg);
        break;
      case 'cookies.getAll':
        await handleCookiesGetAll(msg);
        break;
      case 'cookies.set':
        await handleCookiesSet(msg);
        break;
      case 'screenshot':
        await handleScreenshot(msg);
        break;
      case 'getCaptchaToken':
        await handleGetCaptchaToken(msg);
        break;
      case 'sandbox.open':
        // Open the sandbox page as a new tab
        const sandboxUrl = chrome.runtime.getURL('sandbox.html');
        await chrome.tabs.create({ url: sandboxUrl, active: false });
        log('info', 'sandbox-opened', { url: sandboxUrl });
        sendResult(msg.id, { ok: true, url: sandboxUrl });
        break;
      default:
        log('warn', 'unknown-command', { type: msg.type });
        sendError(msg.id, `Unknown command type: ${msg.type}`);
    }
  } catch (err) {
    sendError(msg.id, err.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Command: fetch — execute fetch() from the extension's browser context
// ---------------------------------------------------------------------------

async function handleFetch(cmd) {
  const { id, url, method, headers, body, credentials, timeoutMs } = cmd;
  log('debug', 'fetch-start', { id, url, method });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);

  try {
    const fetchOptions = {
      method: method || 'GET',
      headers: headers || {},
      credentials: credentials || 'include',
      redirect: 'follow',
      signal: controller.signal,
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = body;
    }

    const res = await fetch(url, fetchOptions);

    // Read the response body, handling zstd/gzip/deflate decompression.
    // Chrome's service worker fetch() does NOT automatically decompress zstd
    // (even though the browser's main fetch pipeline does). We use
    // DecompressionStream (Chrome 143+) to handle zstd manually.
    let responseBody;
    const contentEncoding = res.headers.get('content-encoding') || '';

    if (contentEncoding.includes('zstd')) {
      // Decompress zstd using DecompressionStream API (Chrome 143+)
      try {
        const ds = new DecompressionStream('zstd');
        const decompressed = res.body.pipeThrough(ds);
        responseBody = await new Response(decompressed).text();
      } catch (e) {
        // Fallback: try reading as text (might get garbled, but at least we try)
        log('warn', 'fetch-zstd-decompress-failed', { id, url, error: e.message });
        responseBody = await res.text();
      }
    } else {
      // gzip/deflate are handled natively by fetch().text()
      responseBody = await res.text();
    }

    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    log('debug', 'fetch-done', { id, url, status: res.status, bodyLen: responseBody.length, encoding: contentEncoding });

    sendResult(id, {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: responseBody,
      finalUrl: res.url,
      headers: responseHeaders,
    });
  } catch (err) {
    log('error', 'fetch-error', { id, url, error: err.message });
    sendError(id, err.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Command: tabs.open / tabs.close / tabs.list / tabs.focus
// ---------------------------------------------------------------------------

async function handleTabsOpen(cmd) {
  const { id, url, active } = cmd;
  const tab = await chrome.tabs.create({ url, active: active !== false });
  log('info', 'tab-opened', { id, tabId: tab.id, url });
  // Wait for the tab to finish loading
  await waitForTabLoaded(tab.id, 30000);
  sendResult(id, { ok: true, tabId: tab.id, url: tab.url });
}

async function handleTabsClose(cmd) {
  const { id, tabId } = cmd;
  await chrome.tabs.remove(tabId);
  log('info', 'tab-closed', { id, tabId });
  sendResult(id, { ok: true });
}

async function handleTabsList(cmd) {
  const { id } = cmd;
  const tabs = await chrome.tabs.query({});
  const simplified = tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
  sendResult(id, { ok: true, tabs: simplified });
}

async function handleTabsFocus(cmd) {
  const { id, tabId } = cmd;
  await chrome.tabs.update(tabId, { active: true });
  sendResult(id, { ok: true });
}

function waitForTabLoaded(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(tabId_, changeInfo, tab) {
      if (tabId_ === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay for JS frameworks to render
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command: form.fill / form.click / form.wait / form.eval
// ---------------------------------------------------------------------------

async function handleFormFill(cmd) {
  const { id, tabId, selector, value } = cmd;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      // Set value using the native input setter (works for React-controlled inputs)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (el.tagName === 'TEXTAREA') {
        nativeTextareaValueSetter.call(el, val);
      } else {
        nativeInputValueSetter.call(el, val);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },
    args: [selector, value],
  });
  const result = results[0]?.result || { ok: false, error: 'No result' };
  log('debug', 'form.fill', { id, tabId, selector, value, ok: result.ok });
  sendResult(id, result);
}

async function handleFormClick(cmd) {
  const { id, tabId, selector } = cmd;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      el.click();
      return { ok: true };
    },
    args: [selector],
  });
  const result = results[0]?.result || { ok: false, error: 'No result' };
  log('debug', 'form.click', { id, tabId, selector, ok: result.ok });
  sendResult(id, result);
}

async function handleFormWait(cmd) {
  const { id, tabId, selector, timeoutMs } = cmd;
  const timeout = timeoutMs || 30000;
  const startTime = Date.now();

  const poll = async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => !!document.querySelector(sel),
      args: [selector],
    });
    return results[0]?.result === true;
  };

  while (Date.now() - startTime < timeout) {
    if (await poll()) {
      log('debug', 'form.wait-found', { id, tabId, selector, ms: Date.now() - startTime });
      sendResult(id, { ok: true, found: true, waitedMs: Date.now() - startTime });
      return;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  log('warn', 'form.wait-timeout', { id, tabId, selector, timeoutMs: timeout });
  sendResult(id, { ok: false, error: `Element not found within ${timeout}ms: ${selector}` });
}

async function handleFormEval(cmd) {
  const { id, tabId, function: fn, args } = cmd;
  // Use chrome.debugger + Runtime.evaluate to run JS in the page's main
  // world. This bypasses BOTH the extension's CSP (MV3 forbids unsafe-eval)
  // AND the page's CSP (debugger runs with full privileges).
  //
  // The function body is wrapped: `(function(args){ <body> })(<args>)`
  // and evaluated via Runtime.evaluate, which returns the result directly.
  try {
    // Attach the debugger
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      if (!err.message.includes('Another debugger')) {
        throw err;
      }
    }
    // Enable the Runtime domain
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    // Build the expression — wrap the function body and call it with args
    const expression = `(function(args){ ${fn} })(${JSON.stringify(args || [])})`;
    // Evaluate in the page's main world
    const evalResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,  // ← was false — needed for async functions
        userGesture: true,
      }
    );
    // Detach
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) { /* already detached */ }
    if (evalResult.exceptionDetails) {
      const exc = evalResult.exceptionDetails;
      const errMsg = exc.exception?.description || exc.text || 'Unknown error';
      sendResult(id, { ok: false, error: errMsg.slice(0, 500) });
    } else {
      const value = evalResult.result?.value;
      sendResult(id, { ok: true, result: value });
    }
  } catch (err) {
    log('error', 'form.eval-failed', { id, tabId, error: err.message });
    sendResult(id, { ok: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Command: getCaptchaToken — read the hCaptcha response token from the page
//
// Uses chrome.scripting.executeScript with world: 'MAIN' to run a REAL
// function (not eval) in the page's main world. This gives access to
// window.hcaptcha.getResponse() without triggering CSP restrictions
// (real function references are allowed; only new Function(string) is blocked).
// No debugger banner, no CSP bypass needed.
// ---------------------------------------------------------------------------

async function handleGetCaptchaToken(cmd) {
  const { id, tabId } = cmd;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // Try multiple ways to read the hCaptcha token
        // 1. hcaptcha.getResponse() — the official API
        // 2. document.querySelector('textarea[name="h-captcha-response"]') — fallback
        try {
          if (typeof hcaptcha !== 'undefined' && typeof hcaptcha.getResponse === 'function') {
            const token = hcaptcha.getResponse();
            if (token) return { ok: true, token: token, source: 'hcaptcha.getResponse' };
          }
        } catch (e) {}
        // Fallback: look for the hidden textarea
        const ta = document.querySelector('textarea[name="h-captcha-response"]');
        if (ta && ta.value) {
          return { ok: true, token: ta.value, source: 'textarea' };
        }
        // Check if hCaptcha iframe is even present
        const iframe = document.querySelector('iframe[src*="hcaptcha"]');
        return {
          ok: false,
          error: 'No hCaptcha token found',
          captchaPresent: !!iframe,
          hcaptchaDefined: typeof hcaptcha !== 'undefined',
        };
      },
    });
    const result = results[0]?.result || { ok: false, error: 'No result' };
    log('info', 'getCaptchaToken', { id, tabId, ok: result.ok, source: result.source });
    sendResult(id, result);
  } catch (err) {
    log('error', 'getCaptchaToken-failed', { id, tabId, error: err.message });
    sendResult(id, { ok: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Command: xhr.intercept — intercept XHR responses matching a URL pattern
//
// Uses chrome.debugger API to attach to a tab and intercept network requests.
// When a request matches the urlPattern, captures the request body + response
// body + headers and sends them back as an xhr.event.
// ---------------------------------------------------------------------------

async function handleXhrIntercept(cmd) {
  const { id, tabId, urlPattern, method, timeoutMs } = cmd;
  const timeout = timeoutMs || 30000;

  log('info', 'xhr.intercept-start', { id, tabId, urlPattern, method });

  // Attach the debugger to the tab
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    // "Another debugger is already attached" is OK — we're already attached
    if (!err.message.includes('Another debugger')) {
      sendError(id, `Failed to attach debugger: ${err.message}`);
      return;
    }
  }

  // Enable Network domain
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');

  // Set up listener for network events
  const captured = {
    requestId: null,
    requestMethod: null,
    requestUrl: null,
    requestHeaders: null,
    requestBody: null,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
  };

  const urlRegex = new RegExp(urlPattern);

  const listener = async (source, method_, params) => {
    if (source.tabId !== tabId) return;

    if (method_ === 'Network.requestWillBeSent') {
      const url = params.request.url;
      if (urlRegex.test(url) && (!method || params.request.method === method)) {
        captured.requestId = params.requestId;
        captured.requestMethod = params.request.method;
        captured.requestUrl = url;
        captured.requestHeaders = params.request.headers;
        captured.requestBody = params.request.postData || null;
        log('info', 'xhr.intercept-request-matched', { id, url, method: params.request.method });
      }
    }

    if (method_ === 'Network.responseReceived') {
      if (params.requestId === captured.requestId) {
        captured.responseStatus = params.response.status;
        captured.responseHeaders = params.response.headers;
        log('debug', 'xhr.intercept-response-received', { id, status: params.response.status });
      }
    }

    if (method_ === 'Network.loadingFinished') {
      if (params.requestId === captured.requestId) {
        // Fetch the response body
        try {
          const bodyResp = await chrome.debugger.sendCommand(
            { tabId },
            'Network.getResponseBody',
            { requestId: params.requestId }
          );
          captured.responseBody = bodyResp.body;
        } catch (err) {
          log('warn', 'xhr.intercept-body-fetch-failed', { id, error: err.message });
        }
        // Send the captured XHR event back to the server
        log('info', 'xhr.intercept-complete', { id, url: captured.requestUrl, status: captured.responseStatus });
        sendResult(id, {
          ok: true,
          xhr: {
            method: captured.requestMethod,
            url: captured.requestUrl,
            requestHeaders: captured.requestHeaders,
            requestBody: captured.requestBody,
            responseStatus: captured.responseStatus,
            responseHeaders: captured.responseHeaders,
            responseBody: captured.responseBody,
          },
        });
        // Detach
        chrome.debugger.onEvent.removeListener(listener);
        try {
          await chrome.debugger.detach({ tabId });
        } catch (e) { /* already detached */ }
      }
    }
  };

  chrome.debugger.onEvent.addListener(listener);

  // Timeout
  setTimeout(async () => {
    if (captured.requestId === null) {
      log('warn', 'xhr.intercept-timeout', { id, urlPattern, timeoutMs: timeout });
      chrome.debugger.onEvent.removeListener(listener);
      try {
        await chrome.debugger.detach({ tabId });
      } catch (e) { /* already detached */ }
      sendError(id, `No XHR matching ${urlPattern} within ${timeout}ms`);
    }
  }, timeout);
}

// ---------------------------------------------------------------------------
// Command: cookies.get / cookies.getAll / cookies.set
// ---------------------------------------------------------------------------

async function handleCookiesGet(cmd) {
  const { id, url, name } = cmd;
  const cookie = await chrome.cookies.get({ url, name });
  sendResult(id, { ok: true, cookie });
}

async function handleCookiesGetAll(cmd) {
  const { id, url } = cmd;
  const cookies = await chrome.cookies.getAll({ url });
  log('debug', 'cookies.getAll', { id, url, count: cookies.length });
  sendResult(id, { ok: true, cookies });
}

async function handleCookiesSet(cmd) {
  const { id, url, cookies } = cmd;
  const results = [];
  for (const c of cookies) {
    const r = await chrome.cookies.set({
      url,
      name: c.name,
      value: c.value,
      domain: c.domain || '.supabase.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: c.httpOnly || false,
      sameSite: c.sameSite || 'lax',
      expirationDate: c.expirationDate,
    });
    results.push(r);
  }
  sendResult(id, { ok: true, count: results.length });
}

// ---------------------------------------------------------------------------
// Command: screenshot
// ---------------------------------------------------------------------------

async function handleScreenshot(cmd) {
  const { id, tabId } = cmd;
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  log('debug', 'screenshot', { id, tabId, len: dataUrl.length });
  sendResult(id, { ok: true, dataUrl });
}

// ---------------------------------------------------------------------------
// Status broadcast to popup
// ---------------------------------------------------------------------------

function broadcastStatus() {
  const status = {
    status: state.status,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    commandsReceived: state.commandsReceived,
    commandsCompleted: state.commandsCompleted,
    commandsFailed: state.commandsFailed,
    lastCommandAt: state.lastCommandAt,
    agentId: state.agentId,
    serverUrl: state.serverUrl,
  };
  try { chrome.runtime.sendMessage({ type: 'status', status }); } catch (e) { /* popup not open */ }
}

// ---------------------------------------------------------------------------
// Message handler for popup → background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    connect(msg.serverUrl).then(() => sendResponse({ ok: true }));
    return true;  // async
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'getStatus') {
    sendResponse({
      status: state.status,
      connectedAt: state.connectedAt,
      lastError: state.lastError,
      commandsReceived: state.commandsReceived,
      commandsCompleted: state.commandsCompleted,
      commandsFailed: state.commandsFailed,
      lastCommandAt: state.lastCommandAt,
      agentId: state.agentId,
      serverUrl: state.serverUrl,
      log: state.log.slice(-50),
    });
    return false;
  }
  if (msg.type === 'clearLog') {
    state.log = [];
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Command: page.fetch — execute fetch() from a PAGE's main world context
//
// Needed because the service worker's fetch() can't decompress zstd
// (DecompressionStream doesn't support zstd in Chrome 151 service worker).
// The page's main world fetch() handles zstd natively via Chrome's network stack.
//
// Requires a Supabase tab to be open (the fetch runs in that tab's context).
// Uses chrome.scripting with world: 'MAIN' to execute in the page's main world.
// ---------------------------------------------------------------------------

async function handlePageFetch(cmd) {
  const { id, tabId, url, method, headers, body, credentials, timeoutMs } = cmd;
  log('debug', 'page.fetch-start', { id, url, method, tabId });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (fetchUrl, fetchMethod, fetchHeaders, fetchBody, fetchCredentials) => {
        const options = {
          method: fetchMethod || 'GET',
          headers: fetchHeaders || {},
          credentials: fetchCredentials || 'include',
        };
        if (fetchBody && fetchMethod !== 'GET' && fetchMethod !== 'HEAD') {
          options.body = fetchBody;
        }
        const res = await fetch(fetchUrl, options);
        const text = await res.text();
        const responseHeaders = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          body: text,
          finalUrl: res.url,
          headers: responseHeaders,
        };
      },
      args: [url, method || 'GET', headers || {}, body, credentials || 'include'],
    });

    const result = results[0]?.result;
    if (!result) {
      sendError(id, 'No result from page fetch');
      return;
    }

    log('debug', 'page.fetch-done', {
      id, url, status: result.status,
      bodyLen: result.body?.length,
      encoding: result.headers?.['content-encoding'] || 'none'
    });
    sendResult(id, result);
  } catch (err) {
    log('error', 'page.fetch-failed', { id, url, error: err.message });
    sendError(id, err.message);
  }
}

// ---------------------------------------------------------------------------
// Auto-connect on install/startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
});

// Auto-connect on service worker startup (handles browser restart)
(async () => {
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
})();
