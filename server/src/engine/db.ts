// Minimal SQL interface. The Durable Object adapts ctx.storage.sql to it;
// tests adapt node:sqlite. Both run the same SQLite dialect.

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Db {
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  run(sql: string, ...params: SqlValue[]): void;
  /** Runs fn atomically; throws roll everything back. */
  tx<T>(fn: () => T): T;
  /** Cumulative rows written by this adapter instance (for the free-tier budget meter). */
  rowsWritten(): number;
}

// No column in this schema holds personal information. Do not add any.
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS house (id INTEGER PRIMARY KEY CHECK (id = 1), take INTEGER NOT NULL, net INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS players (
     id TEXT PRIMARY KEY,
     initials TEXT NOT NULL,
     tag INTEGER NOT NULL,
     slip_hash TEXT NOT NULL UNIQUE,
     balance INTEGER NOT NULL,
     total_lost INTEGER NOT NULL DEFAULT 0,
     tier TEXT NOT NULL DEFAULT 'adjunct',
     research_opt_in INTEGER NOT NULL DEFAULT 0,
     session_limit INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     player_id TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS markets (
     id INTEGER PRIMARY KEY,
     type TEXT NOT NULL,
     question_key TEXT,
     question TEXT,
     venue TEXT,
     topic TEXT,
     owner_player_id TEXT,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     closes_at INTEGER NOT NULL,
     resolve_at INTEGER,
     resolved_at INTEGER,
     outcome TEXT,
     source_note TEXT NOT NULL DEFAULT '',
     auto INTEGER NOT NULL DEFAULT 0,
     probability REAL,
     pool_yes INTEGER NOT NULL DEFAULT 0,
     pool_no INTEGER NOT NULL DEFAULT 0,
     house_seed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS markets_state ON markets(state)`,
  `CREATE TABLE IF NOT EXISTS bets (
     id INTEGER PRIMARY KEY,
     player_id TEXT NOT NULL,
     market_id INTEGER NOT NULL,
     side TEXT NOT NULL,
     stake INTEGER NOT NULL,
     parlay_id INTEGER,
     payout INTEGER,
     placed_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bets_market ON bets(market_id)`,
  `CREATE INDEX IF NOT EXISTS bets_player ON bets(player_id)`,
  `CREATE TABLE IF NOT EXISTS ledger (
     id INTEGER PRIMARY KEY,
     player_id TEXT,
     kind TEXT NOT NULL,
     amount INTEGER NOT NULL,
     ref_id INTEGER,
     at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_log (
     id INTEGER PRIMARY KEY,
     action TEXT NOT NULL,
     target_id INTEGER,
     at INTEGER NOT NULL)`,
];

export const TABLES = ["meta", "house", "players", "sessions", "markets", "bets", "ledger", "admin_log"];
