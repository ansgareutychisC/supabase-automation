/**
 * Mock extension harness for E2E testing the worker without a real browser.
 *
 * This simulates the Chrome extension's behavior:
 * - Connects to the worker's BridgeHub DO via WebSocket
 * - Responds to commands (tabs.open, form.fill, form.click, fetch, etc.)
 * - For signup: simulates the hCaptcha token + form submission
 *
 * Usage:
 *   node tests/mock-extension.mjs --url wss://supabase-onboarding-worker.21cc20ac.workers.dev/ws --token <bridge-token>
 *
 * Or for local testing:
 *   node tests/mock-extension.mjs --url ws://localhost:8787/ws
 */

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
let url = 'ws://localhost:8787/ws';
let token = '';
let email = 'mock-test@privatimail.com';
let password = 'MockTest123!Secure';
let verbose = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if (args[i] === '--email' && args[i + 1]) email = args[++i];
    else if (args[i] === '--password' && args[i + 1]) password = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else if (args[i] === '--help') {
        console.log('Usage: node mock-extension.mjs --url <ws-url> [--token <auth>] [--email X] [--password Y] [-v]');
        process.exit(0);
    }
}

const agentId = 'mock-ext-' + Math.random().toString(36).slice(2, 8);
let cmdCount = 0;
let tabCounter = 1000;
const tabs = new Map(); // tabId → {url, title, content}

function log(level, msg, data) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
}

function connect() {
    log('info', `Connecting to ${url} as ${agentId}...`);
    const ws = new WebSocket(url, {
        headers: token ? { 'x-bridge-token': token } : {},
    });

    ws.on('open', () => {
        log('info', 'WebSocket connected');
        ws.send(JSON.stringify({ type: 'auth', token }));
        ws.send(JSON.stringify({
            type: 'connect',
            agentId,
            userAgent: 'mock-extension/1.0',
            hostname: 'test-harness',
        }));
    });

    ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (verbose) log('debug', '← message', { type: msg.type, id: msg.id });

        if (msg.type === 'auth-ok') {
            log('info', 'Authenticated');
            return;
        }
        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            return;
        }

        // Command
        cmdCount++;
        log('info', `→ command #${cmdCount}: ${msg.type}`, { id: msg.id?.slice(0, 8) });
        try {
            const result = await handleCommand(msg);
            ws.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
            log('info', `✓ result for ${msg.type}`, { id: msg.id?.slice(0, 8) });
        } catch (err) {
            ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: err.message }));
            log('error', `✗ error for ${msg.type}: ${err.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        log('warn', `WebSocket closed: ${code} ${reason}`);
        // Reconnect after 5s
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        log('error', `WebSocket error: ${err.message}`);
    });

    // Keepalive
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
    }, 25000);
}

async function handleCommand(msg) {
    switch (msg.type) {
        case 'tabs.open': {
            const tabId = ++tabCounter;
            tabs.set(tabId, { url: msg.url, title: 'Supabase', content: '' });
            log('info', `  opened tab ${tabId}: ${msg.url}`);
            return { ok: true, tabId, url: msg.url };
        }
        case 'tabs.close':
            tabs.delete(msg.tabId);
            return { ok: true };
        case 'tabs.list':
            return { ok: true, tabs: Array.from(tabs.entries()).map(([id, t]) => ({ id, ...t })) };
        case 'form.fill':
            log('info', `  filled ${msg.selector} = ${msg.value?.slice(0, 30)}...`);
            return { ok: true };
        case 'form.click':
            log('info', `  clicked ${msg.selector}`);
            // If this is the submit button, simulate signup success
            if (msg.selector?.includes('submit')) {
                log('info', '  (simulating hCaptcha solve + form submission)');
                log('info', `  → signup would create account for ${email}`);
            }
            return { ok: true };
        case 'form.wait':
            return { ok: true };
        case 'form.eval':
            // Return mock values based on the function
            if (msg.function?.includes('btnDisabled')) {
                return { ok: true, result: false };
            }
            if (msg.function?.includes('email')) {
                return { ok: true, result: email };
            }
            if (msg.function?.includes('title')) {
                return { ok: true, result: 'Supabase' };
            }
            return { ok: true, result: null };
        case 'fetch': {
            // Simulate fetch responses
            log('info', `  fetch ${msg.method} ${msg.url?.slice(0, 80)}`);
            if (msg.url?.includes('/platform/signup')) {
                return { ok: true, status: 201, body: '', headers: {} };
            }
            if (msg.url?.includes('/auth/v1/verify')) {
                return {
                    ok: true,
                    status: 303,
                    body: '',
                    headers: {
                        location: `https://app.supabase.com#access_token=mock_jwt_token&refresh_token=mock_refresh&expires_in=1800&token_type=bearer&type=signup`,
                    },
                };
            }
            if (msg.url?.includes('/auth/v1/user')) {
                return {
                    ok: true,
                    status: 200,
                    body: JSON.stringify({
                        id: 'mock-user-id',
                        email,
                        email_confirmed_at: new Date().toISOString(),
                    }),
                    headers: { 'content-type': 'application/json' },
                };
            }
            if (msg.url?.includes('/platform/profile') && msg.method === 'POST') {
                return {
                    ok: true,
                    status: 201,
                    body: JSON.stringify({
                        id: 99999,
                        gotrue_id: 'mock-user-id',
                        primary_email: email,
                        free_project_limit: 2,
                    }),
                    headers: { 'content-type': 'application/json' },
                };
            }
            return { ok: true, status: 200, body: '{}', headers: {} };
        }
        case 'cookies.getAll':
            return { ok: true, cookies: [] };
        case 'cookies.get':
            return { ok: true, cookie: null };
        case 'screenshot':
            return { ok: true, dataUrl: 'data:image/png;base64,mock' };
        case 'getCaptchaToken':
            // Simulate a solved hCaptcha token
            return { ok: true, token: 'P1_mock_hcaptcha_token_' + Date.now() };
        case 'xhr.intercept':
            // Simulate capturing the signup XHR
            return {
                ok: true,
                xhr: {
                    method: 'POST',
                    url: 'https://api.supabase.com/platform/signup',
                    responseStatus: 201,
                    responseBody: '',
                    requestBody: JSON.stringify({ email, password, hcaptchaToken: 'P1_mock' }),
                },
            };
        default:
            log('warn', `  unknown command type: ${msg.type}`);
            return { ok: true };
    }
}

// Handle Ctrl+C
process.on('SIGINT', () => {
    log('info', 'Shutting down...');
    process.exit(0);
});

connect();
