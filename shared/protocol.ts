// Wire protocol shared by server and clients, plus strict validators.
// The server never trusts a message that has not passed one of these parsers.

export type Side = "yes" | "no";
export type MarketType = "micro" | "future" | "personal";
export type MarketState = "open" | "closed" | "resolved" | "void";

export type ErrorCode =
  | "invalid"
  | "blocked_initials"
  | "age_required"
  | "not_authenticated"
  | "insufficient_funds"
  | "below_min"
  | "market_closed"
  | "no_market"
  | "rate_limited"
  | "restore_failed"
  | "forbidden"
  | "internal";

// ---------- client -> server ----------

export type Intent =
  | { t: "join"; initials: string; adult: true }
  | { t: "auth"; token: string }
  | { t: "restore"; slip: string }
  | { t: "bet"; marketId: number; side: Side; stake: number }
  | { t: "ping" };

export type ClientMessage = Intent & { rid?: number };

// ---------- server -> client ----------

export interface MarketView {
  id: number;
  type: MarketType;
  question: string;
  sourceNote: string;
  state: MarketState;
  closesAt: number;
  resolvedAt: number | null;
  outcome: Side | null;
  poolYes: number;
  poolNo: number;
  /** American odds strings, e.g. "+150" / "-200", net of the rake. */
  oddsYes: string;
  oddsNo: string;
  auto: boolean;
}

export interface LeaderRow {
  name: string;
  balance: number;
}

export interface TickerItem {
  id: string;
  at: number;
  kind: "bet" | "resolved" | "void" | "join";
  who?: string;
  stake?: number;
  side?: Side;
  question?: string;
  outcome?: Side;
}

export interface PublicState {
  now: number;
  markets: MarketView[];
  leaders: LeaderRow[];
  house: { take: number };
  ticker: TickerItem[];
  featuredId: number | null;
  players: number;
}

export interface MyBet {
  id: number;
  marketId: number;
  question: string;
  side: Side;
  stake: number;
  payout: number | null;
  state: "open" | "won" | "lost" | "void";
  placedAt: number;
}

export interface MeState {
  id: string;
  name: string;
  balance: number;
  totalLost: number;
  bets: MyBet[];
}

export interface ResultNotice {
  kind: "result";
  marketId: number;
  question: string;
  outcome: Side | "void";
  side: Side;
  stake: number;
  payout: number;
}

export type ServerMessage =
  | { t: "reply"; rid: number; ok: true; data?: unknown }
  | { t: "reply"; rid: number; ok: false; error: ErrorCode }
  | { t: "public"; state: PublicState }
  | { t: "me"; me: MeState }
  | { t: "notice"; notice: ResultNotice }
  | { t: "reset" };

export interface JoinResult {
  token: string;
  slip: string;
  me: MeState;
}

// ---------- admin ----------

export type AdminAction =
  | { action: "create"; type: "micro" | "future"; question: string; closesInMinutes: number; sourceNote: string }
  | { action: "close"; marketId: number }
  | { action: "resolve"; marketId: number; outcome: Side }
  | { action: "void"; marketId: number }
  | { action: "autopilot"; enabled: boolean }
  | { action: "reset"; confirm: "RESET" };

export interface AdminMarket extends MarketView {
  stale: boolean;
  betCount: number;
}

export interface AdminState {
  now: number;
  markets: AdminMarket[];
  players: number;
  houseTake: number;
  houseNet: number;
  autopilot: boolean;
  rowsWrittenToday: number;
  rowsBudget: number;
  rowsWarnAt: number;
  log: { action: string; targetId: number | null; at: number }[];
}

// ---------- validators ----------

const SLIP_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
export const SLIP_LENGTH = 13; // 65 bits

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function onlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function isInt(x: unknown, min: number, max: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
}

function isSide(x: unknown): x is Side {
  return x === "yes" || x === "no";
}

export function isValidInitials(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{3}$/.test(s);
}

/** Normalizes user-entered slip codes (dashes, spaces, lowercase, O/I/L confusion). */
export function normalizeSlip(s: string): string | null {
  const cleaned = s
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== SLIP_LENGTH) return null;
  for (const ch of cleaned) if (!SLIP_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function formatSlip(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export { SLIP_ALPHABET };

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  if (raw.rid !== undefined && !isInt(raw.rid, 0, 2 ** 31)) return null;
  const rid = raw.rid as number | undefined;
  const base = rid === undefined ? {} : { rid };
  switch (raw.t) {
    case "join":
      if (!onlyKeys(raw, ["t", "rid", "initials", "adult"])) return null;
      if (typeof raw.initials !== "string" || raw.initials.length !== 3) return null;
      if (raw.adult !== true) return null;
      return { ...base, t: "join", initials: raw.initials, adult: true };
    case "auth":
      if (!onlyKeys(raw, ["t", "rid", "token"])) return null;
      if (typeof raw.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.token)) return null;
      return { ...base, t: "auth", token: raw.token };
    case "restore":
      if (!onlyKeys(raw, ["t", "rid", "slip"])) return null;
      if (typeof raw.slip !== "string" || raw.slip.length > 32) return null;
      return { ...base, t: "restore", slip: raw.slip };
    case "bet":
      if (!onlyKeys(raw, ["t", "rid", "marketId", "side", "stake"])) return null;
      if (!isInt(raw.marketId, 1, 1e9) || !isSide(raw.side) || !isInt(raw.stake, 1, 1e9)) return null;
      return { ...base, t: "bet", marketId: raw.marketId, side: raw.side, stake: raw.stake };
    case "ping":
      if (!onlyKeys(raw, ["t", "rid"])) return null;
      return { ...base, t: "ping" };
    default:
      return null;
  }
}

function isCleanText(x: unknown, min: number, max: number): x is string {
  // Operator-authored text. Rendered as text everywhere; control characters rejected.
  return typeof x === "string" && x.length >= min && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
}

export function parseAdminAction(raw: unknown): AdminAction | null {
  if (!isObj(raw) || typeof raw.action !== "string") return null;
  switch (raw.action) {
    case "create":
      if (!onlyKeys(raw, ["action", "type", "question", "closesInMinutes", "sourceNote"])) return null;
      if (raw.type !== "micro" && raw.type !== "future") return null;
      if (!isCleanText(raw.question, 5, 200) || !isCleanText(raw.sourceNote, 0, 200)) return null;
      if (!isInt(raw.closesInMinutes, 1, 60 * 24 * 800)) return null;
      return {
        action: "create",
        type: raw.type,
        question: raw.question.trim(),
        closesInMinutes: raw.closesInMinutes,
        sourceNote: raw.sourceNote.trim(),
      };
    case "close":
    case "void":
      if (!onlyKeys(raw, ["action", "marketId"]) || !isInt(raw.marketId, 1, 1e9)) return null;
      return { action: raw.action, marketId: raw.marketId };
    case "resolve":
      if (!onlyKeys(raw, ["action", "marketId", "outcome"])) return null;
      if (!isInt(raw.marketId, 1, 1e9) || !isSide(raw.outcome)) return null;
      return { action: "resolve", marketId: raw.marketId, outcome: raw.outcome };
    case "autopilot":
      if (!onlyKeys(raw, ["action", "enabled"]) || typeof raw.enabled !== "boolean") return null;
      return { action: "autopilot", enabled: raw.enabled };
    case "reset":
      if (!onlyKeys(raw, ["action", "confirm"]) || raw.confirm !== "RESET") return null;
      return { action: "reset", confirm: "RESET" };
    default:
      return null;
  }
}

export function displayName(initials: string, tag: number): string {
  return tag <= 1 ? initials : `${initials}·${tag}`;
}
