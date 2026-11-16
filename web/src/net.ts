// Connection to the game server: WebSocket with automatic reconnect,
// falling back to slow HTTP polling while the socket is down.
// The client never computes balances or payouts; it only renders what the
// server sends.

import { gameConfig } from "../../config/game.config";
import type {
  ErrorCode,
  Intent,
  MeState,
  PublicState,
  ResultNotice,
  ServerMessage,
} from "../../shared/protocol";
import { store } from "./dom";

const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function httpBase(): string {
  return SERVER || window.location.origin;
}
function wsUrl(): string {
  return httpBase().replace(/^http/, "ws") + "/ws";
}

export class RequestError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export interface Handlers {
  onPublic?(s: PublicState): void;
  onMe?(m: MeState): void;
  onNotice?(n: ResultNotice): void;
  onReset?(): void;
  onStatus?(online: boolean): void;
  onSignedOut?(): void;
}

const TOKEN_KEY = "cr.token";

export class Connection {
  private ws: WebSocket | null = null;
  private rid = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: number }>();
  private failures = 0;
  private pollTimer: number | null = null;
  private pingTimer: number | null = null;
  private online = false;

  constructor(
    private readonly h: Handlers,
    private readonly useToken: boolean,
  ) {}

  get token(): string | null {
    return this.useToken ? store.get(TOKEN_KEY) : null;
  }
  setToken(t: string | null): void {
    if (t) store.set(TOKEN_KEY, t);
    else store.del(TOKEN_KEY);
  }

  start(): void {
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }

  private connect(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.setOnline(true);
      this.stopPolling();
      const token = this.token;
      if (token) {
        this.call<{ me: MeState }>({ t: "auth", token })
          .then((r) => this.h.onMe?.(r.me))
          .catch((e: RequestError) => {
          if (e.code === "not_authenticated") {
            this.setToken(null);
            this.h.onSignedOut?.();
          }
        });
      }
      this.pingTimer = window.setInterval(() => {
        // Exact string matches the server's auto-response; does not wake the server.
        if (ws.readyState === 1) ws.send('{"t":"ping"}');
      }, 25_000);
    };
    ws.onmessage = (ev) => this.dispatch(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.setOnline(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.failures++;
    const delay = Math.min(gameConfig.realtime.maxReconnectMs, 500 * 2 ** Math.min(this.failures, 5));
    window.setTimeout(() => this.connect(), delay + Math.random() * 300);
    if (this.failures >= 2) this.startPolling();
  }

  private setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    this.h.onStatus?.(v);
  }

  private dispatch(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: ServerMessage | { t: "pong" };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case "pong":
        return;
      case "public":
        return this.h.onPublic?.(msg.state);
      case "me":
        return this.h.onMe?.(msg.me);
      case "notice":
        return this.h.onNotice?.(msg.notice);
      case "reset":
        this.setToken(null);
        this.h.onReset?.();
        return;
      case "reply": {
        const p = this.pending.get(msg.rid);
        if (!p) return;
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new RequestError(msg.error));
      }
    }
  }

  /** Sends an intent. Uses the socket when open, HTTP otherwise. */
  async call<T = unknown>(intent: Intent): Promise<T> {
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      const rid = this.rid++;
      return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(rid);
          reject(new RequestError("internal"));
        }, 10_000);
        this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
        ws.send(JSON.stringify({ ...intent, rid }));
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.token;
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${httpBase()}/api/intent`, { method: "POST", headers, body: JSON.stringify(intent) });
    } catch {
      throw new RequestError("internal");
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: ErrorCode };
    if (body.ok) {
      void this.poll();
      return body.data as T;
    }
    throw new RequestError(body.error ?? "internal");
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    void this.poll();
    this.pollTimer = window.setInterval(() => void this.poll(), gameConfig.realtime.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    try {
      const s = await fetch(`${httpBase()}/api/state`);
      if (s.ok) this.h.onPublic?.((await s.json()) as PublicState);
      const token = this.token;
      if (token) {
        const m = await fetch(`${httpBase()}/api/me`, { headers: { authorization: `Bearer ${token}` } });
        if (m.ok) this.h.onMe?.((await m.json()) as MeState);
        else if (m.status === 401) {
          this.setToken(null);
          this.h.onSignedOut?.();
        }
      }
    } catch {
      /* still offline */
    }
  }
}

export { httpBase };
