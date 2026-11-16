// The single Durable Object that owns all game state. It adapts SQLite storage
// to the engine, serves WebSockets (with hibernation), rate-limits per
// connection, and pushes state to clients.

import { DurableObject } from "cloudflare:workers";
import { gameConfig } from "../../config/game.config";
import seed from "../../config/markets.seed.json";
import blocklist from "../../config/initials-blocklist.json";
import {
  parseAdminAction,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "../../shared/protocol";
import type { Db, SqlValue } from "./engine/db";
import { Game, GameError, type SeedFile } from "./engine/game";
import { Window, newConnLimits, type ConnLimits } from "./engine/ratelimit";

export interface Env {
  GAME: DurableObjectNamespace<GameDO>;
  ADMIN_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}

interface Attachment {
  pid: string | null;
}

const MAX_MESSAGE_BYTES = 2048;

function sqlDb(ctx: DurableObjectState): Db {
  const sql = ctx.storage.sql;
  let written = 0;
  let depth = 0;
  const exec = (q: string, params: SqlValue[]) => {
    const cursor = sql.exec(q, ...params);
    const rows = cursor.toArray();
    written += cursor.rowsWritten;
    return rows;
  };
  return {
    all: <T>(q: string, ...p: SqlValue[]) => exec(q, p) as T[],
    one: <T>(q: string, ...p: SqlValue[]) => exec(q, p)[0] as T | undefined,
    run: (q: string, ...p: SqlValue[]) => void exec(q, p),
    // Nested tx() calls join the outermost transaction.
    tx: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      depth++;
      try {
        return ctx.storage.transactionSync(fn);
      } finally {
        depth--;
      }
    },
    rowsWritten: () => written,
  };
}

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export class GameDO extends DurableObject<Env> {
  private readonly db: Db;
  private readonly game: Game;
  private readonly connLimits = new WeakMap<WebSocket, ConnLimits>();
  private readonly httpLimits = new Map<string, ConnLimits>();
  private readonly globalJoins = new Window(gameConfig.limits.global.joinsPerMinute);
  private readonly globalFailedRestores = new Window(gameConfig.limits.global.failedRestoresPerMinute);
  private lastBroadcast = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  // Rows-written meter for the free-tier budget.
  private meterDay = "";
  private meterBase = 0;
  private meterOffset = 0;
  private meterSavedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = sqlDb(ctx);
    this.game = new Game(this.db, {
      config: gameConfig,
      seed: seed as SeedFile,
      blocklist: blocklist.blocked,
    });
    const day = this.db.one<{ v: string }>("SELECT v FROM meta WHERE k = 'rows_day'")?.v ?? "";
    const count = Number(this.db.one<{ v: string }>("SELECT v FROM meta WHERE k = 'rows_count'")?.v ?? 0);
    this.meterDay = day;
    this.meterBase = day === utcDay(Date.now()) ? count : 0;
    this.meterOffset = this.db.rowsWritten();
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  // ---------------------------------------------------------------- HTTP

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ws") return this.acceptSocket();
      if (url.pathname === "/api/state" && request.method === "GET") return json(this.game.publicState());
      if (url.pathname === "/api/me" && request.method === "GET") {
        const pid = await this.pidFromAuth(request);
        if (!pid) return json({ error: "not_authenticated" }, 401);
        return json(this.game.meState(pid));
      }
      if (url.pathname === "/api/intent" && request.method === "POST") return await this.httpIntent(request);
      if (url.pathname.startsWith("/api/admin/")) {
        if (request.headers.get("x-camera-ready-admin") !== "verified") return json({ error: "forbidden" }, 403);
        return await this.admin(url.pathname, request);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      if (err instanceof GameError) return json({ error: err.code }, 400);
      console.error("internal error", (err as Error).message);
      return json({ error: "internal" }, 500);
    }
  }

  private acceptSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null } satisfies Attachment);
    server.send(JSON.stringify({ t: "public", state: this.game.publicState() } satisfies ServerMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async pidFromAuth(request: Request): Promise<string | null> {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
    return m ? this.game.authenticate(m[1]) : null;
  }

  private async httpIntent(request: Request): Promise<Response> {
    const text = await request.text();
    if (text.length > MAX_MESSAGE_BYTES) return json({ error: "invalid" }, 413);
    const msg = parseClientMessage(safeParse(text));
    if (!msg) return json({ error: "invalid" }, 400);
    let pid = await this.pidFromAuth(request);
    const key = pid ?? "anon";
    if (this.httpLimits.size > 5000) this.httpLimits.clear();
    let limits = this.httpLimits.get(key);
    if (!limits) this.httpLimits.set(key, (limits = newConnLimits(gameConfig.limits.perConnection)));
    try {
      const data = await this.handleIntent(msg, limits, () => pid, (p) => (pid = p));
      return json({ ok: true, data });
    } catch (err) {
      if (err instanceof GameError) return json({ ok: false, error: err.code }, 400);
      throw err;
    } finally {
      await this.afterChange();
    }
  }

  private async admin(path: string, request: Request): Promise<Response> {
    if (path === "/api/admin/state" && request.method === "GET") {
      return json(this.game.adminState(this.rowsToday()));
    }
    if (path === "/api/admin/audit" && request.method === "GET") return json(this.game.audit());
    if (path === "/api/admin/action" && request.method === "POST") {
      const text = await request.text();
      if (text.length > MAX_MESSAGE_BYTES) return json({ error: "invalid" }, 413);
      const a = parseAdminAction(safeParse(text));
      if (!a) return json({ error: "invalid" }, 400);
      let result: unknown = null;
      switch (a.action) {
        case "create":
          result = { id: this.game.createMarket(a.type, a.question, a.closesInMinutes, a.sourceNote) };
          break;
        case "close":
          this.game.closeMarket(a.marketId);
          break;
        case "resolve":
          this.game.resolveMarket(a.marketId, a.outcome);
          break;
        case "void":
          this.game.voidMarket(a.marketId);
          break;
        case "autopilot":
          this.game.setAutopilot(a.enabled);
          break;
        case "reset":
          this.game.reset();
          break;
      }
      await this.afterChange();
      return json({ ok: true, data: result, state: this.game.adminState(this.rowsToday()) });
    }
    return json({ error: "not_found" }, 404);
  }

  // ---------------------------------------------------------------- WebSocket

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
    let limits = this.connLimits.get(ws);
    if (!limits) this.connLimits.set(ws, (limits = newConnLimits(gameConfig.limits.perConnection)));
    const parsed = safeParse(raw);
    const msg = parseClientMessage(parsed);
    // Echo the request id even for invalid messages so the client can match the error.
    const rawRid = (parsed as { rid?: unknown } | null)?.rid;
    const rid = msg?.rid ?? (Number.isInteger(rawRid) && (rawRid as number) >= 0 && (rawRid as number) <= 2 ** 31 ? (rawRid as number) : 0);
    if (!msg) return this.send(ws, { t: "reply", rid, ok: false, error: "invalid" });
    if (!limits.msg.take(Date.now())) return this.send(ws, { t: "reply", rid, ok: false, error: "rate_limited" });
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { pid: null };
    try {
      const data = await this.handleIntent(
        msg,
        limits,
        () => (att.pid && this.game.hasPlayer(att.pid) ? att.pid : null),
        (pid) => {
          att.pid = pid;
          ws.serializeAttachment(att);
        },
      );
      this.send(ws, { t: "reply", rid, ok: true, data });
    } catch (err) {
      const code: ErrorCode = err instanceof GameError ? err.code : "internal";
      if (code === "internal") console.error("internal error", (err as Error).message);
      this.send(ws, { t: "reply", rid, ok: false, error: code });
    } finally {
      await this.afterChange();
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.connLimits.delete(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.connLimits.delete(ws);
  }

  private async handleIntent(
    msg: ClientMessage,
    limits: ConnLimits,
    getPid: () => string | null,
    setPid: (pid: string) => void,
  ): Promise<unknown> {
    const now = Date.now();
    switch (msg.t) {
      case "ping":
        return {};
      case "join": {
        if (!limits.join.take(now) || !this.globalJoins.take(now)) throw new GameError("rate_limited");
        const r = await this.game.join(msg.initials);
        setPid(r.me.id);
        return r;
      }
      case "auth": {
        const pid = await this.game.authenticate(msg.token);
        if (!pid) throw new GameError("not_authenticated");
        setPid(pid);
        return { me: this.game.meState(pid) };
      }
      case "restore": {
        if (!limits.restore.take(now)) throw new GameError("rate_limited");
        try {
          const r = await this.game.restore(msg.slip);
          setPid(r.me.id);
          return r;
        } catch (err) {
          if (!this.globalFailedRestores.take(now)) throw new GameError("rate_limited");
          throw err;
        }
      }
      case "bet": {
        const pid = getPid();
        if (!pid) throw new GameError("not_authenticated");
        if (!limits.bet.take(now)) throw new GameError("rate_limited");
        return this.game.placeBet(pid, msg.marketId, msg.side, msg.stake);
      }
    }
  }

  // ---------------------------------------------------------------- clock + push

  async alarm(): Promise<void> {
    await this.afterChange(true);
  }

  private async afterChange(forceMeter = false): Promise<void> {
    const next = this.game.tick();
    this.flush();
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500));
    else await this.ctx.storage.deleteAlarm();
    this.saveMeter(forceMeter);
  }

  private flush(): void {
    const e = this.game.drainEffects();
    const sockets = this.ctx.getWebSockets();
    if (e.reset) {
      for (const ws of sockets) {
        ws.serializeAttachment({ pid: null } satisfies Attachment);
        this.send(ws, { t: "reset" });
      }
    }
    if (e.notices.length || e.mePlayers.size) {
      const byPid = new Map<string, WebSocket[]>();
      for (const ws of sockets) {
        const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
        if (pid) byPid.set(pid, [...(byPid.get(pid) ?? []), ws]);
      }
      for (const n of e.notices) for (const ws of byPid.get(n.playerId) ?? []) this.send(ws, { t: "notice", notice: n.notice });
      for (const pid of e.mePlayers) {
        if (!this.game.hasPlayer(pid) || !byPid.has(pid)) continue;
        const me = this.game.meState(pid);
        for (const ws of byPid.get(pid)!) this.send(ws, { t: "me", me });
      }
    }
    if (e.publicDirty) this.scheduleBroadcast();
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    const wait = gameConfig.realtime.broadcastThrottleMs - (Date.now() - this.lastBroadcast);
    if (wait <= 0) return this.broadcast();
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, wait);
  }

  private broadcast(): void {
    this.lastBroadcast = Date.now();
    const payload = JSON.stringify({ t: "public", state: this.game.publicState() } satisfies ServerMessage);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* socket closing */
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  // ---------------------------------------------------------------- rows-written meter

  private rowsToday(): number {
    const today = utcDay(Date.now());
    if (today !== this.meterDay) {
      this.meterDay = today;
      this.meterBase = 0;
      this.meterOffset = this.db.rowsWritten();
    }
    return this.meterBase + (this.db.rowsWritten() - this.meterOffset);
  }

  private saveMeter(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.meterSavedAt < 60_000) return;
    this.meterSavedAt = now;
    const count = this.rowsToday();
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('rows_day', ?)", this.meterDay);
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('rows_count', ?)", String(count));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
