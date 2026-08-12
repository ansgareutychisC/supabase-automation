/**
 * BridgeHub Durable Object — manages extension WebSocket connections + command proxy.
 *
 * This is the CF Worker equivalent of the Python bridge daemon. It:
 * - Holds the WebSocket connection to the Chrome extension
 * - Sends commands (fetch, tabs.open, form.fill, form.click, getCaptchaToken, etc.)
 * - Receives results + broadcasts events to dashboard subscribers
 * - Supports round-robin extension selection (for fleet mode)
 *
 * The extension connects to wss://<worker-url>/ws and sends:
 *   {type:'auth', token} → {type:'connect', agentId, ...} → {type:'result', id, ...}
 *
 * The worker sends commands via sendCommand():
 *   {type:'fetch'|'tabs.open'|'form.fill'|..., id, ...}
 *
 * For Supabase, the signup step (hCaptcha) uses form interaction commands.
 * Steps 2-7 (verify, profile, org, PAT) use direct fetch() from the worker.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
    DB: D1Database;
    BRIDGE_HUB: DurableObjectNamespace;
    EMAIL_WORKER_URL: string;
    EMAIL_WORKER_TOKEN: string;
    EMAIL_DOMAIN: string;
    BRIDGE_TOKEN: string;
    BRIDGE_NO_AUTH?: string;
}

interface ExtConnection {
    connId: string;
    agentId: string;
    userAgent: string;
    connectedAt: number;
    lastSeen: number;
    commandCount: number;
    lastCommandAt: number | null;
    authenticated: boolean;
}

interface PendingCommand {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: number;
    type: string;
    startedAt: number;
    connId: string;
}

export class BridgeHub extends DurableObject {
    connections = new Map<string, { ws: WebSocket; info: ExtConnection }>();
    pending = new Map<string, PendingCommand>();
    rrIndex = 0;
    dashboardSubscribers = new Set<WebSocket>();

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // WebSocket upgrade
        if (request.headers.get('Upgrade') === 'websocket') {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);

            if (url.pathname === '/ws/dashboard') {
                this.handleDashboard(server);
            } else {
                this.handleExtension(server, request);
            }

            return new Response(null, { status: 101, webSocket: client });
        }

        // HTTP endpoints on the DO (internal, called by the worker)
        if (url.pathname === '/status') {
            return Response.json(this.getStatus());
        }

        if (url.pathname === '/command' && request.method === 'POST') {
            const body = await request.json() as any;
            try {
                const result = await this.sendCommand(body.cmd, body.timeout || 60000);
                return Response.json(result);
            } catch (err) {
                return Response.json({ ok: false, error: (err as Error).message }, { status: 502 });
            }
        }

        return new Response('Not found', { status: 404 });
    }

    // --- Extension WebSocket handling ---

    handleExtension(ws: WebSocket, request: Request) {
        ws.accept();
        const connId = 'ext_' + crypto.randomUUID().slice(0, 12);
        const token = request.headers.get('x-bridge-token') || '';

        const info: ExtConnection = {
            connId,
            agentId: 'unknown',
            userAgent: request.headers.get('user-agent') || 'unknown',
            connectedAt: Date.now(),
            lastSeen: Date.now(),
            commandCount: 0,
            lastCommandAt: null,
            authenticated: false,
        };

        ws.addEventListener('message', async (event: MessageEvent) => {
            let msg: any;
            try { msg = JSON.parse(event.data as string); } catch { return; }

            // Pre-auth: only allow auth + log + pong
            if (!info.authenticated && msg.type !== 'auth' && msg.type !== 'log' && msg.type !== 'pong') {
                ws.close(1008, 'Not authenticated');
                return;
            }

            switch (msg.type) {
                case 'auth':
                    if (token === (this.env as Env).BRIDGE_TOKEN || (this.env as Env).BRIDGE_NO_AUTH === '1') {
                        info.authenticated = true;
                        this.connections.set(connId, { ws, info });
                        ws.send(JSON.stringify({ type: 'auth-ok' }));
                    } else {
                        ws.close(1008, 'Invalid token');
                    }
                    break;

                case 'connect':
                    info.agentId = msg.agentId || 'unknown';
                    info.userAgent = msg.userAgent || info.userAgent;
                    info.lastSeen = Date.now();
                    this.broadcastDashboard({
                        type: 'extension:connected',
                        data: { connId, agentId: info.agentId },
                    });
                    break;

                case 'result': {
                    const pending = this.pending.get(msg.id);
                    if (pending) {
                        this.pending.delete(msg.id);
                        clearTimeout(pending.timer);
                        info.commandCount++;
                        info.lastCommandAt = Date.now();
                        if (msg.error) {
                            pending.reject(new Error(msg.error));
                        } else {
                            pending.resolve(msg);
                        }
                    }
                    break;
                }

                case 'log':
                    console.log(`[ext:${info.agentId}] ${msg.message}`, msg.data || '');
                    break;

                case 'pong':
                    info.lastSeen = Date.now();
                    break;
            }
        });

        ws.addEventListener('close', () => {
            this.connections.delete(connId);
            for (const [id, cmd] of this.pending) {
                if (cmd.connId === connId) {
                    this.pending.delete(id);
                    clearTimeout(cmd.timer);
                    cmd.reject(new Error('Extension disconnected'));
                }
            }
            this.broadcastDashboard({
                type: 'extension:disconnected',
                data: { connId },
            });
        });

        // Keepalive ping every 30s (MV3 service workers die after 30s inactivity)
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.READY_STATE_OPEN) {
                ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
            } else {
                clearInterval(pingInterval);
            }
        }, 30000);
    }

    // --- Dashboard WebSocket ---

    handleDashboard(ws: WebSocket) {
        ws.accept();
        this.dashboardSubscribers.add(ws);

        ws.addEventListener('close', () => {
            this.dashboardSubscribers.delete(ws);
        });

        ws.send(JSON.stringify({
            type: 'dashboard:init',
            data: this.getStatus(),
        }));
    }

    broadcastDashboard(event: any) {
        const msg = JSON.stringify(event);
        for (const ws of this.dashboardSubscribers) {
            if (ws.readyState === WebSocket.READY_STATE_OPEN) {
                ws.send(msg);
            }
        }
    }

    // --- Extension selection (round-robin) ---

    pickExtension(): { ws: WebSocket; info: ExtConnection } | undefined {
        const open = [...this.connections.values()].filter(
            c => c.ws.readyState === WebSocket.READY_STATE_OPEN && c.info.authenticated
        );
        if (!open.length) return undefined;
        const conn = open[this.rrIndex % open.length];
        this.rrIndex++;
        return conn;
    }

    // --- Core primitive: send any command to the extension ---

    async sendCommand(cmd: any, timeoutMs: number = 60000): Promise<any> {
        const conn = this.pickExtension();
        if (!conn) {
            throw new Error('No extension connected');
        }

        const cmdId = 'cmd_' + crypto.randomUUID().slice(0, 12);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(cmdId);
                reject(new Error(`Command ${cmd.type} timed out after ${timeoutMs}ms`));
            }, timeoutMs + 5000);

            this.pending.set(cmdId, {
                resolve,
                reject,
                timer,
                type: cmd.type,
                startedAt: Date.now(),
                connId: conn.info.connId,
            });

            try {
                conn.ws.send(JSON.stringify({ ...cmd, id: cmdId }));
            } catch (err) {
                this.pending.delete(cmdId);
                clearTimeout(timer);
                reject(new Error(`Failed to send command: ${(err as Error).message}`));
            }
        });
    }

    // --- Convenience: fetch via extension ---

    async fetchViaExtension(url: string, options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        credentials?: string;
        timeoutMs?: number;
    } = {}): Promise<{
        ok: boolean;
        status: number;
        statusText: string;
        body: string;
        finalUrl: string;
        headers: Record<string, string>;
    }> {
        const result = await this.sendCommand({
            type: 'fetch',
            url,
            method: options.method || 'GET',
            headers: options.headers || {},
            credentials: options.credentials || 'include',
            body: options.body,
            timeoutMs: options.timeoutMs || 30000,
        }, options.timeoutMs || 30000);
        return result;
    }

    // --- Status ---

    getStatus() {
        return {
            extensions: [...this.connections.values()].map(c => ({
                connId: c.info.connId,
                agentId: c.info.agentId,
                commandCount: c.info.commandCount,
                authenticated: c.info.authenticated,
                connectedAt: c.info.connectedAt,
            })),
            pendingCommands: this.pending.size,
            dashboardSubscribers: this.dashboardSubscribers.size,
        };
    }
}
