// Test harness: runs the real engine against node:sqlite (same SQLite dialect
// as Durable Objects), with a controllable clock and seeded randomness.

import { DatabaseSync } from "node:sqlite";
import { gameConfig, type GameConfig } from "../config/game.config";
import seed from "../config/markets.seed.json";
import blocklist from "../config/initials-blocklist.json";
import type { Db, SqlValue } from "../server/src/engine/db";
import { Game, type SeedFile } from "../server/src/engine/game";

export function nodeDb(): Db {
  const d = new DatabaseSync(":memory:");
  let written = 0;
  let depth = 0;
  const isRead = (q: string) => /^\s*SELECT/i.test(q);
  return {
    all: <T>(q: string, ...p: SqlValue[]) => {
      const st = d.prepare(q);
      const rows = st.all(...p) as T[];
      if (!isRead(q)) written += rows.length || 1;
      return rows.map((r) => ({ ...(r as object) }) as T);
    },
    one: <T>(q: string, ...p: SqlValue[]) => {
      const st = d.prepare(q);
      if (!isRead(q)) {
        const rows = st.all(...p) as T[];
        written += rows.length || 1;
        return rows[0] ? ({ ...(rows[0] as object) } as T) : undefined;
      }
      const r = st.get(...p) as T | undefined;
      return r ? ({ ...(r as object) } as T) : undefined;
    },
    run: (q: string, ...p: SqlValue[]) => {
      const r = d.prepare(q).run(...p);
      written += Number(r.changes);
    },
    tx: <T>(fn: () => T): T => {
      // Nested tx() calls join the outer transaction, like transactionSync.
      if (depth > 0) return fn();
      depth++;
      d.exec("BEGIN");
      try {
        const out = fn();
        d.exec("COMMIT");
        return out;
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    rowsWritten: () => written,
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeGame(opts: { config?: GameConfig; seed?: SeedFile; random?: () => number; start?: number } = {}) {
  const clock = { t: opts.start ?? Date.parse("2027-05-10T14:00:00Z") };
  const db = nodeDb();
  const game = new Game(db, {
    config: opts.config ?? gameConfig,
    seed: opts.seed ?? (seed as SeedFile),
    blocklist: blocklist.blocked,
    now: () => clock.t,
    random: opts.random ?? rng(42),
  });
  return { game, db, clock };
}

export function withConfig(patch: (c: GameConfig) => unknown): GameConfig {
  const c = structuredClone(gameConfig) as GameConfig;
  patch(c);
  return c;
}
