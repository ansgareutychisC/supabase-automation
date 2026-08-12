/**
 * Popup script — connection config + live diagnostics monitor.
 *
 * The popup is just a monitor: it shows connection status, command counts,
 * and a live log feed from the background service worker. All the actual
 * work happens in background.js.
 */

const serverUrlInput = document.getElementById('serverUrl');
const connectBtn = document.getElementById('connectBtn');
const autoConnectCheckbox = document.getElementById('autoConnect');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statReceived = document.getElementById('statReceived');
const statCompleted = document.getElementById('statCompleted');
const statFailed = document.getElementById('statFailed');
const logArea = document.getElementById('logArea');
const clearLogBtn = document.getElementById('clearLogBtn');
const agentIdEl = document.getElementById('agentId');

let logEntries = [];
let refreshInterval = null;

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

(async () => {
  const cfg = await chrome.storage.local.get(['serverUrl', 'autoConnect']);
  serverUrlInput.value = cfg.serverUrl || 'ws://localhost:8787/ws';
  autoConnectCheckbox.checked = cfg.autoConnect !== false;
  refreshStatus();
  // Start polling for status updates
  refreshInterval = setInterval(refreshStatus, 1000);
})();

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

connectBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim();
  if (!url) return;

  await chrome.storage.local.set({ serverUrl: url, autoConnect: autoConnectCheckbox.checked });

  if (connectBtn.textContent === 'Connect') {
    connectBtn.textContent = 'Connecting...';
    connectBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'connect', serverUrl: url });
    setTimeout(() => {
      connectBtn.textContent = 'Disconnect';
      connectBtn.disabled = false;
      refreshStatus();
    }, 1000);
  } else {
    await chrome.runtime.sendMessage({ type: 'disconnect' });
    connectBtn.textContent = 'Connect';
    refreshStatus();
  }
});

autoConnectCheckbox.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoConnect: autoConnectCheckbox.checked });
});

clearLogBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearLog' });
  logEntries = [];
  renderLog();
  refreshStatus();
});

document.getElementById('openSandboxBtn').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('sandbox.html');
  await chrome.tabs.create({ url, active: false });
});

// ---------------------------------------------------------------------------
// Status polling + rendering
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (!resp) return;
    renderStatus(resp);
    if (resp.log) {
      logEntries = resp.log;
      renderLog();
    }
  } catch (e) {
    // Background service worker might be starting up
  }
}

function renderStatus(s) {
  // Status dot
  statusDot.className = 'status-dot ' + s.status;
  const statusLabels = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
    error: 'Error',
  };
  statusText.textContent = statusLabels[s.status] || s.status;
  if (s.status === 'connected') {
    connectBtn.textContent = 'Disconnect';
  } else if (s.status === 'connecting') {
    connectBtn.textContent = 'Connecting...';
  } else {
    connectBtn.textContent = 'Connect';
  }

  // Stats
  statReceived.textContent = s.commandsReceived || 0;
  statCompleted.textContent = s.commandsCompleted || 0;
  statFailed.textContent = s.commandsFailed || 0;

  // Agent ID
  agentIdEl.textContent = s.agentId || 'ext-???';

  // Error
  if (s.lastError && s.status === 'error') {
    statusText.textContent = s.lastError.slice(0, 50);
  }
}

function renderLog() {
  if (!logEntries || logEntries.length === 0) {
    logArea.innerHTML = '<div style="color:#666;font-style:italic;">No activity yet</div>';
    return;
  }
  // Show last 50 entries, newest at bottom
  const html = logEntries.slice(-50).map(e => {
    const time = e.ts.split('T')[1]?.split('.')[0] || e.ts;
    const level = e.level || 'info';
    let dataStr = '';
    if (e.data) {
      try {
        dataStr = ' ' + JSON.stringify(e.data).slice(0, 200);
      } catch (err) { /* ignore */ }
    }
    return `<div class="log-entry ${level}"><span class="log-time">${time}</span><span class="log-level">${level.toUpperCase()}</span>${escapeHtml(e.message)}${escapeHtml(dataStr)}</div>`;
  }).join('');
  logArea.innerHTML = html;
  // Auto-scroll to bottom
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Listen for live log updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log' && msg.entry) {
    logEntries.push(msg.entry);
    if (logEntries.length > 200) logEntries.shift();
    renderLog();
  } else if (msg.type === 'status') {
    renderStatus(msg.status);
  }
});

// Cleanup on popup close
window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});
