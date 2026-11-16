// The authoritative game. All balances, pools, and payouts are computed here
// and every balance change goes through ledger(). Transport-agnostic: the
// Durable Object and the tests both drive this class directly.

import type { GameConfig } from "../../../config/game.config";
import {
  displayName,
  isValidInitials,
  normalizeSlip,
  type AdminMarket,
  type AdminState,
  type ErrorCode,
  type JoinResult,
  type LeaderRow,
  type MarketState,
  type MarketType,
  type MarketView,
  type MeState,
  type MyBet,
  type PublicState,
  type ResultNotice,
  type Side,
  type TickerItem,
} from "../../../shared/protocol";
import { newSlipCode, newToken, randomId, sha256 } from "./crypto";
import { SCHEMA, TABLES, type Db } from "./db";
import { americanOdds, payoutMultiple, splitPool } from "./odds";

export class GameError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export interface SeedMarket {
  key: string;
  type: "micro" | "future";
  question: string;
  sourceNote: string;
  closesInMinutes?: number;
  closesAt?: string;
}
export interface AutoTemplate {
  key: string;
  question: string;
  probability: number;
  sourceNote: string;
}
export interface SeedFile {
  markets: SeedMarket[];
  autopilot: AutoTemplate[];
}

export interface GameOptions {
  config: GameConfig;
  seed: SeedFile;
  blocklist: string[];
  now?: () => number;
  /** Used only for autopilot outcomes and template choice. */
  random?: () => number;
}

interface PlayerCache {
  id: string;
  initials: string;
  tag: number;
  balance: number;
  totalLost: number;
  createdAt: number;
}

interface MarketRow {
  id: number;
  type: MarketType;
  question_key: string | null;
  question: string | null;
  state: MarketState;
  created_at: number;
  closes_at: number;
  resolve_at: number | null;
  resolved_at: number | null;
  outcome: Side | null;
  source_note: string;
  auto: number;
  probability: number | null;
  pool_yes: number;
  pool_no: number;
  house_seed: number;
}

export interface Effects {
  publicDirty: boolean;
  mePlayers: Set<string>;
  notices: { playerId: string; notice: ResultNotice }[];
  reset: boolean;
}

/** House ledger kinds that count toward THE PUBLISHER's displayed take. */
const TAKE_KINDS = new Set(["rake", "apc", "registration", "review_credit"]);

export class Game {
  private readonly cfg: GameConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly blocklist: Set<string>;

  private players = new Map<string, PlayerCache>();
  private live = new Map<number, MarketRow>();
  private recent: MarketRow[] = [];
  private ticker: TickerItem[] = [];
  private house = { take: 0, net: 0 };
  private autopilot = true;
  private sessions = new Map<string, string>();
  private lastActivity = 0;
  private effects: Effects = Game.emptyEffects();

  constructor(
    private readonly db: Db,
    private readonly opts: GameOptions,
  ) {
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.blocklist = new Set(opts.blocklist.map((s) => s.toUpperCase()));
    for (const stmt of SCHEMA) db.run(stmt);
    if (!db.one("SELECT v FROM meta WHERE k = 'seeded'")) {
      db.tx(() => this.seedAll());
    }
    this.load();
  }

  static emptyEffects(): Effects {
    return { publicDirty: false, mePlayers: new Set(), notices: [], reset: false };
  }

  drainEffects(): Effects {
    const e = this.effects;
    this.effects = Game.emptyEffects();
    return e;
  }

  // ---------------------------------------------------------------- loading

  private load(): void {
    this.players.clear();
    for (const r of this.db.all<{
      id: string; initials: string; tag: number; balance: number; total_lost: number; created_at: number;
    }>("SELECT id, initials, tag, balance, total_lost, created_at FROM players")) {
      this.players.set(r.id, {
        id: r.id, initials: r.initials, tag: r.tag, balance: r.balance, totalLost: r.total_lost, createdAt: r.created_at,
      });
    }
    this.live.clear();
    for (const m of this.db.all<MarketRow>("SELECT * FROM markets WHERE state IN ('open','closed')")) {
      this.live.set(m.id, m);
    }
    this.recent = this.db.all<MarketRow>(
      "SELECT * FROM markets WHERE state IN ('resolved','void') ORDER BY id DESC LIMIT 8",
    );
    const h = this.db.one<{ take: number; net: number }>("SELECT take, net FROM house WHERE id = 1");
    this.house = h ? { take: h.take, net: h.net } : { take: 0, net: 0 };
    const ap = this.db.one<{ v: string }>("SELECT v FROM meta WHERE k = 'autopilot'");
    this.autopilot = ap ? ap.v === "1" : this.cfg.autopilot.enabledByDefault;
    this.rebuildTicker();
  }

  private rebuildTicker(): void {
    const n = this.cfg.realtime.tickerLength;
    const items: TickerItem[] = [];
    for (const b of this.db.all<{ id: number; player_id: string; side: Side; stake: number; placed_at: number }>(
      "SELECT id, player_id, side, stake, placed_at FROM bets ORDER BY id DESC LIMIT ?", n,
    )) {
      items.push({ id: `bet:${b.id}`, at: b.placed_at, kind: "bet", who: this.nameOf(b.player_id), stake: b.stake, side: b.side });
    }
    for (const m of this.recent) {
      items.push(this.resolutionTicker(m));
    }
    for (const p of this.players.values()) {
      items.push({ id: `join:${p.id}`, at: p.createdAt, kind: "join", who: displayName(p.initials, p.tag) });
    }
    items.sort((a, b) => b.at - a.at);
    this.ticker = items.slice(0, n);
  }

  private nameOf(playerId: string): string {
    const p = this.players.get(playerId);
    return p ? displayName(p.initials, p.tag) : "???";
  }

  private pushTicker(item: TickerItem): void {
    this.ticker.unshift(item);
    if (this.ticker.length > this.cfg.realtime.tickerLength) this.ticker.length = this.cfg.realtime.tickerLength;
    this.effects.publicDirty = true;
  }

  private resolutionTicker(m: MarketRow): TickerItem {
    return m.state === "void"
      ? { id: `void:${m.id}`, at: m.resolved_at ?? 0, kind: "void", question: m.question ?? "" }
      : { id: `res:${m.id}`, at: m.resolved_at ?? 0, kind: "resolved", question: m.question ?? "", outcome: m.outcome ?? "no" };
  }

  // ---------------------------------------------------------------- ledger

  /** The only way any balance changes. */
  private ledger(playerId: string | null, kind: string, amount: number, refId: number | null): void {
    const at = this.now();
    this.db.run("INSERT INTO ledger (player_id, kind, amount, ref_id, at) VALUES (?, ?, ?, ?, ?)", playerId, kind, amount, refId, at);
    if (playerId) {
      this.db.run("UPDATE players SET balance = balance + ? WHERE id = ?", amount, playerId);
      const p = this.players.get(playerId);
      if (p) p.balance += amount;
      this.effects.mePlayers.add(playerId);
    } else {
      this.house.net += amount;
      if (TAKE_KINDS.has(kind)) this.house.take += amount;
      this.db.run("UPDATE house SET take = ?, net = ? WHERE id = 1", this.house.take, this.house.net);
    }
    this.effects.publicDirty = true;
  }

  // ---------------------------------------------------------------- seeding

  private seedAll(): void {
    const now = this.now();
    this.db.run("INSERT OR REPLACE INTO house (id, take, net) VALUES (1, 0, 0)");
    this.house = { take: 0, net: 0 };
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('autopilot', ?)", this.cfg.autopilot.enabledByDefault ? "1" : "0");
    for (const s of this.opts.seed.markets) {
      const closesAt = s.closesAt ? Date.parse(s.closesAt) : now + (s.closesInMinutes ?? this.cfg.markets.defaultMicroMinutes) * 60_000;
      if (!(closesAt > now)) continue; // skip seeds already in the past
      this.insertMarket({ type: s.type, key: s.key, question: s.question, sourceNote: s.sourceNote, closesAt });
    }
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', ?)", String(now));
  }

  private insertMarket(m: {
    type: MarketType; key: string | null; question: string; sourceNote: string; closesAt: number;
    auto?: boolean; probability?: number; resolveAt?: number;
  }): MarketRow {
    const seed = this.cfg.economy.houseSeedPerSide;
    const now = this.now();
    const row = this.db.one<MarketRow>(
      `INSERT INTO markets (type, question_key, question, state, created_at, closes_at, resolve_at, source_note, auto, probability, pool_yes, pool_no, house_seed)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      m.type, m.key, m.question, now, m.closesAt, m.resolveAt ?? null, m.sourceNote, m.auto ? 1 : 0, m.probability ?? null, seed, seed, seed,
    )!;
    if (seed > 0) this.ledger(null, "house_seed", -2 * seed, row.id);
    this.live.set(row.id, row);
    this.effects.publicDirty = true;
    return row;
  }

  // ---------------------------------------------------------------- players

  async join(initials: string): Promise<JoinResult> {
    if (!isValidInitials(initials)) throw new GameError("invalid");
    if (this.blocklist.has(initials)) throw new GameError("blocked_initials");
    const slip = newSlipCode();
    const token = newToken();
    const [slipHash, tokenHash] = await Promise.all([sha256(slip), sha256(token)]);
    const now = this.now();
    const id = randomId();
    const tag = 1 + [...this.players.values()].filter((p) => p.initials === initials).length;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO players (id, initials, tag, slip_hash, balance, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        id, initials, tag, slipHash, now,
      );
      this.players.set(id, { id, initials, tag, balance: 0, totalLost: 0, createdAt: now });
      this.ledger(id, "grant", this.cfg.economy.startupFunds, null);
      this.db.run("INSERT INTO sessions (token_hash, player_id, created_at) VALUES (?, ?, ?)", tokenHash, id, now);
    });
    this.sessions.set(tokenHash, id);
    this.lastActivity = now;
    this.pushTicker({ id: `join:${id}`, at: now, kind: "join", who: displayName(initials, tag) });
    return { token, slip, me: this.meState(id) };
  }

  async restore(slipInput: string): Promise<{ token: string; me: MeState }> {
    const slip = normalizeSlip(slipInput);
    if (!slip) throw new GameError("restore_failed");
    const row = this.db.one<{ id: string }>("SELECT id FROM players WHERE slip_hash = ?", await sha256(slip));
    if (!row) throw new GameError("restore_failed");
    const token = newToken();
    const tokenHash = await sha256(token);
    this.db.run("INSERT INTO sessions (token_hash, player_id, created_at) VALUES (?, ?, ?)", tokenHash, row.id, this.now());
    this.sessions.set(tokenHash, row.id);
    this.lastActivity = this.now();
    return { token, me: this.meState(row.id) };
  }

  async authenticate(token: string): Promise<string | null> {
    const h = await sha256(token);
    let id = this.sessions.get(h);
    if (!id) {
      id = this.db.one<{ player_id: string }>("SELECT player_id FROM sessions WHERE token_hash = ?", h)?.player_id;
      if (id) this.sessions.set(h, id);
    }
    if (!id || !this.players.has(id)) return null;
    this.lastActivity = this.now();
    return id;
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }

  // ---------------------------------------------------------------- betting

  placeBet(playerId: string, marketId: number, side: Side, stake: number): { betId: number } {
    const p = this.players.get(playerId);
    if (!p) throw new GameError("not_authenticated");
    const m = this.live.get(marketId);
    if (!m) {
      const exists = this.db.one("SELECT id FROM markets WHERE id = ?", marketId);
      throw new GameError(exists ? "market_closed" : "no_market");
    }
    const now = this.now();
    if (m.state !== "open" || now >= m.closes_at) throw new GameError("market_closed");
    if (!Number.isInteger(stake) || stake < this.cfg.economy.minStake) throw new GameError("below_min");
    if (stake > p.balance) throw new GameError("insufficient_funds");

    const betId = this.db.tx(() => {
      const bet = this.db.one<{ id: number }>(
        "INSERT INTO bets (player_id, market_id, side, stake, placed_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        playerId, marketId, side, stake, now,
      )!;
      this.ledger(playerId, "stake", -stake, bet.id);
      const col = side === "yes" ? "pool_yes" : "pool_no";
      this.db.run(`UPDATE markets SET ${col} = ${col} + ? WHERE id = ?`, stake, marketId);
      return bet.id;
    });
    if (side === "yes") m.pool_yes += stake;
    else m.pool_no += stake;
    this.lastActivity = now;
    this.pushTicker({ id: `bet:${betId}`, at: now, kind: "bet", who: displayName(p.initials, p.tag), stake, side });
    return { betId };
  }

  // ---------------------------------------------------------------- market lifecycle

  createMarket(type: "micro" | "future", question: string, closesInMinutes: number, sourceNote: string): number {
    const row = this.db.tx(() =>
      this.insertMarket({ type, key: null, question, sourceNote, closesAt: this.now() + closesInMinutes * 60_000 }),
    );
    this.adminLog("create", row.id);
    return row.id;
  }

  closeMarket(id: number, byAdmin = true): void {
    const m = this.live.get(id);
    if (!m || m.state !== "open") throw new GameError("market_closed");
    this.db.run("UPDATE markets SET state = 'closed' WHERE id = ?", id);
    m.state = "closed";
    this.effects.publicDirty = true;
    if (byAdmin) this.adminLog("close", id);
  }

  resolveMarket(id: number, outcome: Side, byAdmin = true): void {
    const m = this.live.get(id);
    if (!m) throw new GameError("market_closed");
    const now = this.now();
    const bets = this.db.all<{ id: number; player_id: string; side: Side; stake: number }>(
      "SELECT id, player_id, side, stake FROM bets WHERE market_id = ? ORDER BY id", id,
    );
    const pool = m.pool_yes + m.pool_no;
    const winners = bets.filter((b) => b.side === outcome);
    const losers = bets.filter((b) => b.side !== outcome);
    // House seed sits on both sides; it competes for the pool like any stake.
    const winningStakes = [...winners.map((b) => b.stake), m.house_seed];
    const split = splitPool(pool, winningStakes, this.cfg.economy.rakeRate);
    const housePayout = split.payouts[split.payouts.length - 1];

    this.db.tx(() => {
      winners.forEach((b, i) => {
        const payout = split.payouts[i];
        this.db.run("UPDATE bets SET payout = ? WHERE id = ?", payout, b.id);
        if (payout > 0) this.ledger(b.player_id, "payout", payout, b.id);
        if (payout < b.stake) this.addLoss(b.player_id, b.stake - payout);
        this.effects.mePlayers.add(b.player_id);
        this.effects.notices.push({
          playerId: b.player_id,
          notice: { kind: "result", marketId: id, question: m.question ?? "", outcome, side: b.side, stake: b.stake, payout },
        });
      });
      for (const b of losers) {
        this.db.run("UPDATE bets SET payout = 0 WHERE id = ?", b.id);
        this.addLoss(b.player_id, b.stake);
        this.effects.mePlayers.add(b.player_id);
        this.effects.notices.push({
          playerId: b.player_id,
          notice: { kind: "result", marketId: id, question: m.question ?? "", outcome, side: b.side, stake: b.stake, payout: 0 },
        });
      }
      if (housePayout > 0) this.ledger(null, "house_payout", housePayout, id);
      this.ledger(null, "rake", split.rake + split.dust, id);
      this.db.run("UPDATE markets SET state = 'resolved', outcome = ?, resolved_at = ? WHERE id = ?", outcome, now, id);
    });
    this.retire(m, { state: "resolved", outcome, resolved_at: now });
    if (byAdmin) this.adminLog(`resolve:${outcome}`, id);
  }

  voidMarket(id: number, byAdmin = true): void {
    const m = this.live.get(id);
    if (!m) throw new GameError("market_closed");
    const now = this.now();
    const bets = this.db.all<{ id: number; player_id: string; side: Side; stake: number }>(
      "SELECT id, player_id, side, stake FROM bets WHERE market_id = ? ORDER BY id", id,
    );
    this.db.tx(() => {
      for (const b of bets) {
        this.db.run("UPDATE bets SET payout = ? WHERE id = ?", b.stake, b.id);
        this.ledger(b.player_id, "refund", b.stake, b.id);
        this.effects.notices.push({
          playerId: b.player_id,
          notice: { kind: "result", marketId: id, question: m.question ?? "", outcome: "void", side: b.side, stake: b.stake, payout: b.stake },
        });
      }
      if (m.house_seed > 0) this.ledger(null, "house_refund", 2 * m.house_seed, id);
      this.db.run("UPDATE markets SET state = 'void', resolved_at = ? WHERE id = ?", now, id);
    });
    this.retire(m, { state: "void", outcome: null, resolved_at: now });
    if (byAdmin) this.adminLog("void", id);
  }

  private addLoss(playerId: string, amount: number): void {
    this.db.run("UPDATE players SET total_lost = total_lost + ? WHERE id = ?", amount, playerId);
    const p = this.players.get(playerId);
    if (p) p.totalLost += amount;
  }

  private retire(m: MarketRow, patch: Partial<MarketRow>): void {
    Object.assign(m, patch);
    this.live.delete(m.id);
    this.recent.unshift(m);
    if (this.recent.length > 8) this.recent.length = 8;
    this.pushTicker(this.resolutionTicker(m));
  }

  // ---------------------------------------------------------------- admin

  setAutopilot(enabled: boolean): void {
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('autopilot', ?)", enabled ? "1" : "0");
    this.autopilot = enabled;
    this.adminLog(enabled ? "autopilot:on" : "autopilot:off", null);
    this.effects.publicDirty = true;
  }

  reset(): void {
    this.db.tx(() => {
      for (const t of TABLES) this.db.run(`DELETE FROM ${t}`);
      this.seedAll();
    });
    this.sessions.clear();
    this.lastActivity = 0;
    this.load();
    this.adminLog("reset", null);
    this.effects.reset = true;
    this.effects.publicDirty = true;
  }

  private adminLog(action: string, targetId: number | null): void {
    this.db.run("INSERT INTO admin_log (action, target_id, at) VALUES (?, ?, ?)", action, targetId, this.now());
  }

  // ---------------------------------------------------------------- autopilot / clock

  /** Advances time-based state. Returns the next time tick() needs to run, or null. */
  tick(): number | null {
    const now = this.now();
    for (const m of [...this.live.values()]) {
      if (m.state === "open" && now >= m.closes_at) this.closeMarket(m.id, false);
    }
    for (const m of [...this.live.values()]) {
      if (m.auto && m.state === "closed" && m.resolve_at !== null && now >= m.resolve_at) {
        const p = m.probability ?? 0.5;
        this.resolveMarket(m.id, this.random() < p ? "yes" : "no", false);
      }
    }
    this.spawnAutopilot(now);

    let next: number | null = null;
    for (const m of this.live.values()) {
      const t = m.state === "open" ? m.closes_at : m.auto ? m.resolve_at : null;
      if (t !== null && (next === null || t < next)) next = t;
    }
    return next;
  }

  private spawnAutopilot(now: number): void {
    const ap = this.cfg.autopilot;
    if (!this.autopilot || now - this.lastActivity > ap.idleAfterMinutes * 60_000) return;
    const openAuto = [...this.live.values()].filter((m) => m.auto && m.state === "open");
    const need = ap.minOpen - openAuto.length;
    if (need <= 0) return;
    const usedKeys = new Set([...this.live.values()].map((m) => m.question_key));
    const pool = this.opts.seed.autopilot.filter((t) => !usedKeys.has(t.key));
    const span = ap.openMinutes * 60_000;
    for (let i = 0; i < need && pool.length > 0; i++) {
      const t = pool.splice(Math.floor(this.random() * pool.length), 1)[0];
      const closesAt = now + span + Math.round((i * span) / ap.minOpen);
      this.db.tx(() =>
        this.insertMarket({
          type: "micro", key: t.key, question: t.question, sourceNote: t.sourceNote, closesAt,
          auto: true, probability: t.probability, resolveAt: closesAt + ap.resolveDelaySeconds * 1000,
        }),
      );
    }
  }

  // ---------------------------------------------------------------- views

  private marketView(m: MarketRow): MarketView {
    const rake = this.cfg.economy.rakeRate;
    return {
      id: m.id,
      type: m.type,
      question: m.question ?? "",
      sourceNote: m.source_note,
      state: m.state,
      closesAt: m.closes_at,
      resolvedAt: m.resolved_at,
      outcome: m.outcome,
      poolYes: m.pool_yes,
      poolNo: m.pool_no,
      oddsYes: americanOdds(payoutMultiple(m.pool_yes, m.pool_no, rake)),
      oddsNo: americanOdds(payoutMultiple(m.pool_no, m.pool_yes, rake)),
      auto: m.auto === 1,
    };
  }

  private sortedLive(): MarketRow[] {
    const order = (m: MarketRow) => (m.state === "open" ? 0 : 1) * 10 + (m.type === "micro" ? 0 : 1);
    return [...this.live.values()].sort((a, b) => order(a) - order(b) || a.closes_at - b.closes_at);
  }

  publicState(): PublicState {
    const markets = [...this.sortedLive(), ...this.recent].map((m) => this.marketView(m));
    const leaders: LeaderRow[] = [...this.players.values()]
      .sort((a, b) => b.balance - a.balance || a.createdAt - b.createdAt)
      .slice(0, this.cfg.realtime.leaderboardSize)
      .map((p) => ({ name: displayName(p.initials, p.tag), balance: p.balance }));
    const open = [...this.live.values()].filter((m) => m.state === "open");
    const featured =
      open.filter((m) => m.type === "micro").sort((a, b) => b.pool_yes + b.pool_no - (a.pool_yes + a.pool_no))[0] ??
      open[0];
    return {
      now: this.now(),
      markets,
      leaders,
      house: { take: this.house.take },
      ticker: this.ticker,
      featuredId: featured?.id ?? null,
      players: this.players.size,
    };
  }

  meState(playerId: string): MeState {
    const p = this.players.get(playerId);
    if (!p) throw new GameError("not_authenticated");
    const rows = this.db.all<{
      id: number; market_id: number; side: Side; stake: number; payout: number | null; placed_at: number;
      question: string | null; mstate: MarketState; outcome: Side | null;
    }>(
      `SELECT b.id, b.market_id, b.side, b.stake, b.payout, b.placed_at, m.question, m.state AS mstate, m.outcome
       FROM bets b JOIN markets m ON m.id = b.market_id
       WHERE b.player_id = ? ORDER BY b.id DESC LIMIT 50`,
      playerId,
    );
    const bets: MyBet[] = rows.map((r) => ({
      id: r.id,
      marketId: r.market_id,
      question: r.question ?? "",
      side: r.side,
      stake: r.stake,
      payout: r.payout,
      placedAt: r.placed_at,
      state: r.mstate === "void" ? "void" : r.mstate === "resolved" ? (r.outcome === r.side ? "won" : "lost") : "open",
    }));
    return { id: p.id, name: displayName(p.initials, p.tag), balance: p.balance, totalLost: p.totalLost, bets };
  }

  adminState(rowsWrittenToday: number): AdminState {
    const now = this.now();
    const resolved = this.db.all<MarketRow>(
      "SELECT * FROM markets WHERE state IN ('resolved','void') ORDER BY id DESC LIMIT 30",
    );
    const rows = [...this.sortedLive(), ...resolved];
    const counts = new Map<number, number>();
    if (rows.length) {
      const ids = rows.map((m) => m.id);
      for (const r of this.db.all<{ market_id: number; c: number }>(
        `SELECT market_id, COUNT(*) AS c FROM bets WHERE market_id IN (${ids.map(() => "?").join(",")}) GROUP BY market_id`,
        ...ids,
      )) counts.set(r.market_id, r.c);
    }
    const staleMs = this.cfg.markets.staleAfterHours * 3_600_000;
    const markets: AdminMarket[] = rows.map((m) => ({
      ...this.marketView(m),
      betCount: counts.get(m.id) ?? 0,
      stale: m.state === "closed" && !m.auto && now - m.closes_at > staleMs,
    }));
    const log = this.db
      .all<{ action: string; target_id: number | null; at: number }>(
        "SELECT action, target_id, at FROM admin_log ORDER BY id DESC LIMIT 30",
      )
      .map((r) => ({ action: r.action, targetId: r.target_id, at: r.at }));
    return {
      now,
      markets,
      players: this.players.size,
      houseTake: this.house.take,
      houseNet: this.house.net,
      autopilot: this.autopilot,
      rowsWrittenToday,
      rowsBudget: this.cfg.limits.rowsWrittenDailyBudget,
      rowsWarnAt: this.cfg.limits.rowsWrittenWarnAt,
      log,
    };
  }

  // ---------------------------------------------------------------- audit

  /**
   * Checks the economy's invariants straight from the database.
   * Used by tests and exposed read-only to the admin console.
   */
  audit(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const sums = new Map<string, number>();
    for (const r of this.db.all<{ player_id: string; s: number }>(
      "SELECT player_id, SUM(amount) AS s FROM ledger WHERE player_id IS NOT NULL GROUP BY player_id",
    )) sums.set(r.player_id, r.s);
    for (const p of this.db.all<{ id: string; balance: number }>("SELECT id, balance FROM players")) {
      const s = sums.get(p.id) ?? 0;
      if (s !== p.balance) problems.push(`player ${p.id}: balance ${p.balance} != ledger ${s}`);
      if (p.balance < 0) problems.push(`player ${p.id}: negative balance`);
      const cached = this.players.get(p.id);
      if (!cached || cached.balance !== p.balance) problems.push(`player ${p.id}: cache out of sync`);
    }
    const house = this.db.one<{ take: number; net: number }>("SELECT take, net FROM house WHERE id = 1")!;
    const hn = this.db.one<{ s: number | null }>("SELECT SUM(amount) AS s FROM ledger WHERE player_id IS NULL")!.s ?? 0;
    const ht = this.db.one<{ s: number | null }>(
      "SELECT SUM(amount) AS s FROM ledger WHERE player_id IS NULL AND kind IN ('rake','apc','registration','review_credit')",
    )!.s ?? 0;
    if (house.net !== hn) problems.push(`house net ${house.net} != ledger ${hn}`);
    if (house.take !== ht) problems.push(`house take ${house.take} != ledger ${ht}`);

    // Conservation: points are created only by grants. Everything else is in a
    // balance, the house, or escrowed in an unresolved pool.
    const all = this.db.one<{ s: number | null }>("SELECT SUM(amount) AS s FROM ledger")!.s ?? 0;
    const grants = this.db.one<{ s: number | null }>("SELECT SUM(amount) AS s FROM ledger WHERE kind = 'grant'")!.s ?? 0;
    const escrow = this.db.one<{ s: number | null }>(
      "SELECT SUM(pool_yes + pool_no) AS s FROM markets WHERE state IN ('open','closed')",
    )!.s ?? 0;
    if (all + escrow !== grants) problems.push(`conservation: ledger ${all} + escrow ${escrow} != grants ${grants}`);

    // Every unresolved pool equals its seed plus its bets.
    for (const m of this.db.all<{ id: number; pool_yes: number; pool_no: number; house_seed: number }>(
      "SELECT id, pool_yes, pool_no, house_seed FROM markets WHERE state IN ('open','closed')",
    )) {
      const b = this.db.all<{ side: Side; s: number }>(
        "SELECT side, SUM(stake) AS s FROM bets WHERE market_id = ? GROUP BY side", m.id,
      );
      const y = (b.find((x) => x.side === "yes")?.s ?? 0) + m.house_seed;
      const n = (b.find((x) => x.side === "no")?.s ?? 0) + m.house_seed;
      if (y !== m.pool_yes || n !== m.pool_no) problems.push(`market ${m.id}: pool mismatch`);
    }
    return { ok: problems.length === 0, problems };
  }
}
