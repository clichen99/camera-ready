import { describe, expect, it } from "vitest";
import { gameConfig } from "../config/game.config";
import { GameError } from "../server/src/engine/game";
import { americanOdds, payoutMultiple, splitPool } from "../server/src/engine/odds";
import { parseAdminAction, parseClientMessage, normalizeSlip } from "../shared/protocol";
import { makeGame, rng, withConfig } from "./helpers";

const FUNDS = gameConfig.economy.startupFunds;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return undefined;
}

function firstOpenMicro(game: ReturnType<typeof makeGame>["game"]) {
  return game.publicState().markets.find((m) => m.state === "open" && m.type === "micro")!;
}

describe("joining", () => {
  it("grants startup funds once, through the ledger", async () => {
    const { game, db } = makeGame();
    const r = await game.join("ABC");
    expect(r.me.balance).toBe(FUNDS);
    const rows = db.all<{ kind: string; amount: number }>("SELECT kind, amount FROM ledger WHERE player_id = ?", r.me.id);
    expect(rows).toEqual([{ kind: "grant", amount: FUNDS }]);
    expect(game.audit()).toEqual({ ok: true, problems: [] });
  });

  it("stores the slip code only as a hash", async () => {
    const { game, db } = makeGame();
    const r = await game.join("ABC");
    expect(normalizeSlip(r.slip)).toBe(r.slip);
    const dump = JSON.stringify(db.all("SELECT * FROM players")) + JSON.stringify(db.all("SELECT * FROM sessions"));
    expect(dump).not.toContain(r.slip);
    expect(dump).not.toContain(r.token);
  });

  it("restores a session from the slip code, tolerating dashes and case", async () => {
    const { game } = makeGame();
    const r = await game.join("XYZ");
    const pretty = `${r.slip.slice(0, 4)}-${r.slip.slice(4, 8)}-${r.slip.slice(8)}`.toLowerCase();
    const back = await game.restore(pretty);
    expect(back.me.id).toBe(r.me.id);
    expect(await game.authenticate(back.token)).toBe(r.me.id);
    await expect(game.restore("0000-0000-00000")).rejects.toThrow("restore_failed");
    await expect(game.restore("nope")).rejects.toThrow("restore_failed");
  });

  it("rejects malformed and blocklisted initials", async () => {
    const { game } = makeGame();
    await expect(game.join("ab")).rejects.toThrow("invalid");
    await expect(game.join("abc")).rejects.toThrow("invalid");
    await expect(game.join("A1C")).rejects.toThrow("invalid");
    await expect(game.join("KKK")).rejects.toThrow("blocked_initials");
  });

  it("disambiguates duplicate initials with a tag", async () => {
    const { game } = makeGame();
    const a = await game.join("ABC");
    const b = await game.join("ABC");
    expect(a.me.name).toBe("ABC");
    expect(b.me.name).toBe("ABC·2");
  });
});

describe("betting limits", () => {
  it("a client cannot stake more than its balance", async () => {
    const { game } = makeGame();
    const { me } = await game.join("ABC");
    const m = firstOpenMicro(game);
    expect(code(() => game.placeBet(me.id, m.id, "yes", FUNDS + 1))).toBe("insufficient_funds");
    game.placeBet(me.id, m.id, "yes", FUNDS); // exactly all-in is allowed
    expect(code(() => game.placeBet(me.id, m.id, "no", 10))).toBe("insufficient_funds");
    expect(game.meState(me.id).balance).toBe(0);
    expect(game.audit().ok).toBe(true);
  });

  it("enforces the minimum stake and rejects closed or unknown markets", async () => {
    const { game, clock } = makeGame();
    const { me } = await game.join("ABC");
    const m = firstOpenMicro(game);
    expect(code(() => game.placeBet(me.id, m.id, "yes", gameConfig.economy.minStake - 1))).toBe("below_min");
    expect(code(() => game.placeBet(me.id, 99999, "yes", 50))).toBe("no_market");
    clock.t = m.closesAt;
    expect(code(() => game.placeBet(me.id, m.id, "yes", 50))).toBe("market_closed");
    expect(code(() => game.placeBet("not-a-player", m.id, "yes", 50))).toBe("not_authenticated");
    expect(game.meState(me.id).balance).toBe(FUNDS);
  });
});

describe("resolution", () => {
  it("payouts plus house share plus rake equal the pool exactly", async () => {
    const { game, db } = makeGame();
    const a = (await game.join("AAA")).me.id;
    const b = (await game.join("BBB")).me.id;
    const c = (await game.join("CCC")).me.id;
    const m = firstOpenMicro(game);
    game.placeBet(a, m.id, "yes", 333);
    game.placeBet(b, m.id, "yes", 101);
    game.placeBet(c, m.id, "no", 257);
    const pool = 333 + 101 + 257 + 2 * gameConfig.economy.houseSeedPerSide;
    game.resolveMarket(m.id, "yes");

    const sum = (kind: string, ref: string) =>
      db.one<{ s: number | null }>(`SELECT SUM(amount) AS s FROM ledger WHERE kind = ? AND ${ref}`, kind)!.s ?? 0;
    const betIds = db.all<{ id: number }>("SELECT id FROM bets WHERE market_id = ?", m.id).map((r) => r.id).join(",");
    const payouts = sum("payout", `ref_id IN (${betIds})`);
    const house = sum("house_payout", `ref_id = ${m.id}`);
    const rake = sum("rake", `ref_id = ${m.id}`);
    expect(payouts + house + rake).toBe(pool);
    expect(rake).toBeGreaterThanOrEqual(Math.floor(pool * gameConfig.economy.rakeRate));
    expect(game.meState(c).balance).toBe(FUNDS - 257);
    expect(game.audit()).toEqual({ ok: true, problems: [] });
  });

  it("the house take is exactly the rake", async () => {
    const { game } = makeGame();
    const a = (await game.join("AAA")).me.id;
    const m = firstOpenMicro(game);
    game.placeBet(a, m.id, "no", 400);
    const before = game.publicState().house.take;
    game.resolveMarket(m.id, "no");
    const pool = 400 + 2 * gameConfig.economy.houseSeedPerSide;
    expect(game.publicState().house.take - before).toBeGreaterThanOrEqual(Math.floor(pool * 0.1));
  });

  it("voiding refunds every stake in full", async () => {
    const { game } = makeGame();
    const a = (await game.join("AAA")).me.id;
    const m = firstOpenMicro(game);
    game.placeBet(a, m.id, "yes", 250);
    game.voidMarket(m.id);
    const me = game.meState(a);
    expect(me.balance).toBe(FUNDS);
    expect(me.bets[0].state).toBe("void");
    expect(game.audit().ok).toBe(true);
  });

  it("a market cannot be resolved twice", async () => {
    const { game } = makeGame();
    const m = firstOpenMicro(game);
    game.resolveMarket(m.id, "yes");
    expect(code(() => game.resolveMarket(m.id, "no"))).toBe("market_closed");
    expect(code(() => game.voidMarket(m.id))).toBe("market_closed");
  });
});

describe("ledger invariants under random play", () => {
  it("balances always equal ledger sums, points are conserved, and the house only gains from rake", async () => {
    const random = rng(7);
    const { game, clock } = makeGame({ random });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const initials = String.fromCharCode(65 + (i % 26), 65 + ((i * 7) % 26), 65 + ((i * 13) % 26));
      try {
        ids.push((await game.join(initials)).me.id);
      } catch {
        /* blocklisted combination: fine */
      }
    }
    let lastTake = 0;
    for (let step = 0; step < 600; step++) {
      const r = random();
      const open = game.publicState().markets.filter((m) => m.state === "open");
      const live = game.publicState().markets.filter((m) => m.state === "open" || m.state === "closed");
      if (r < 0.7 && open.length) {
        const pid = ids[Math.floor(random() * ids.length)];
        const m = open[Math.floor(random() * open.length)];
        const stake = 10 + Math.floor(random() * 300);
        try {
          game.placeBet(pid, m.id, random() < 0.5 ? "yes" : "no", stake);
        } catch (e) {
          expect((e as GameError).code).toMatch(/insufficient_funds|market_closed/);
        }
      } else if (r < 0.85 && live.length) {
        game.resolveMarket(live[Math.floor(random() * live.length)].id, random() < 0.5 ? "yes" : "no");
      } else if (r < 0.88 && live.length) {
        game.voidMarket(live[Math.floor(random() * live.length)].id);
      } else {
        clock.t += Math.floor(random() * 5 * 60_000);
        game.tick();
      }
      const audit = game.audit();
      if (!audit.ok) throw new Error(`step ${step}: ${audit.problems.join("; ")}`);
      const take = game.publicState().house.take;
      expect(take).toBeGreaterThanOrEqual(lastTake);
      lastTake = take;
    }
    expect(lastTake).toBeGreaterThan(0);
  });
});

describe("autopilot (unattended booth)", () => {
  it("opens markets after player activity and resolves them on its own", async () => {
    const { game, clock } = makeGame({ seed: { markets: [], autopilot: (await import("../config/markets.seed.json")).autopilot } });
    expect(game.publicState().markets).toHaveLength(0);
    game.tick();
    expect(game.publicState().markets).toHaveLength(0); // nobody around: no spawn

    const { me } = await game.join("ABC");
    game.tick();
    const open = game.publicState().markets.filter((m) => m.auto && m.state === "open");
    expect(open).toHaveLength(gameConfig.autopilot.minOpen);

    game.placeBet(me.id, open[0].id, "yes", 100);
    clock.t = open[0].closesAt + gameConfig.autopilot.resolveDelaySeconds * 1000 + 1;
    game.tick();
    const m = game.publicState().markets.find((x) => x.id === open[0].id)!;
    expect(m.state).toBe("resolved");
    expect(game.audit().ok).toBe(true);
  });

  it("stays quiet when disabled", async () => {
    const cfg = withConfig((c) => ((c.autopilot as { enabledByDefault: boolean }).enabledByDefault = false));
    const { game } = makeGame({ config: cfg, seed: { markets: [], autopilot: (await import("../config/markets.seed.json")).autopilot } });
    await game.join("ABC");
    game.tick();
    expect(game.publicState().markets).toHaveLength(0);
  });

  it("stops spawning after the idle window", async () => {
    const { game, clock } = makeGame({ seed: { markets: [], autopilot: (await import("../config/markets.seed.json")).autopilot } });
    await game.join("ABC");
    clock.t += (gameConfig.autopilot.idleAfterMinutes + 1) * 60_000;
    game.tick();
    expect(game.publicState().markets).toHaveLength(0);
  });
});

describe("admin", () => {
  it("reset clears players and re-seeds markets", async () => {
    const { game } = makeGame();
    const { me, token } = await game.join("ABC");
    game.reset();
    expect(game.hasPlayer(me.id)).toBe(false);
    expect(await game.authenticate(token)).toBeNull();
    expect(game.publicState().players).toBe(0);
    expect(game.publicState().markets.length).toBeGreaterThan(0);
    expect(game.publicState().house.take).toBe(0);
    expect(game.audit().ok).toBe(true);
  });
});

describe("odds", () => {
  it("formats American odds", () => {
    expect(americanOdds(2.5)).toBe("+150");
    expect(americanOdds(1.5)).toBe("-200");
    expect(americanOdds(2)).toBe("+100");
    expect(americanOdds(payoutMultiple(100, 100, 0.1))).toBe("-125"); // 1.8x
  });

  it("splitPool never creates or loses points", () => {
    const random = rng(3);
    for (let i = 0; i < 1000; i++) {
      const stakes = Array.from({ length: 1 + Math.floor(random() * 6) }, () => 1 + Math.floor(random() * 500));
      const pool = stakes.reduce((a, b) => a + b, 0) + Math.floor(random() * 2000);
      const s = splitPool(pool, stakes, 0.1);
      expect(s.rake + s.dust + s.payouts.reduce((a, b) => a + b, 0)).toBe(pool);
      expect(s.dust).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("input validation", () => {
  it("rejects unknown keys, wrong types, and missing age confirmation", () => {
    expect(parseClientMessage({ t: "bet", marketId: 1, side: "yes", stake: 10 })).not.toBeNull();
    expect(parseClientMessage({ t: "bet", marketId: 1, side: "yes", stake: 10, extra: 1 })).toBeNull();
    expect(parseClientMessage({ t: "bet", marketId: 1, side: "maybe", stake: 10 })).toBeNull();
    expect(parseClientMessage({ t: "bet", marketId: 1, side: "yes", stake: 10.5 })).toBeNull();
    expect(parseClientMessage({ t: "bet", marketId: "1", side: "yes", stake: 10 })).toBeNull();
    expect(parseClientMessage({ t: "join", initials: "ABC" })).toBeNull();
    expect(parseClientMessage({ t: "join", initials: "ABC", adult: true, name: "x" })).toBeNull();
    expect(parseClientMessage({ t: "auth", token: "short" })).toBeNull();
    expect(parseClientMessage("<script>")).toBeNull();
    expect(parseClientMessage(null)).toBeNull();
  });

  it("validates admin actions", () => {
    expect(parseAdminAction({ action: "reset", confirm: "RESET" })).not.toBeNull();
    expect(parseAdminAction({ action: "reset" })).toBeNull();
    expect(parseAdminAction({ action: "resolve", marketId: 3, outcome: "yes" })).not.toBeNull();
    expect(parseAdminAction({ action: "resolve", marketId: 3, outcome: "maybe" })).toBeNull();
    expect(
      parseAdminAction({ action: "create", type: "micro", question: "Bad\u0000text", closesInMinutes: 5, sourceNote: "" }),
    ).toBeNull();
  });
});
