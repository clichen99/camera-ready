// Parimutuel pool math. Pure functions; the only place payouts are computed.

export interface PoolSplit {
  rake: number;
  /** Payout per winning stake id (same order as input). */
  payouts: number[];
  /** Pool left over after integer rounding; goes to the house as rake. */
  dust: number;
}

/**
 * Splits a resolved pool. `winningStakes` lists every stake on the winning
 * side (players and house seed alike). Total out always equals `pool`:
 * rake + dust + sum(payouts) === pool.
 */
export function splitPool(pool: number, winningStakes: number[], rakeRate: number): PoolSplit {
  const rake = Math.floor(pool * rakeRate);
  const distributable = pool - rake;
  const winTotal = winningStakes.reduce((a, b) => a + b, 0);
  if (winTotal <= 0) {
    return { rake, payouts: winningStakes.map(() => 0), dust: distributable };
  }
  const payouts = winningStakes.map((s) => Math.floor((distributable * s) / winTotal));
  const paid = payouts.reduce((a, b) => a + b, 0);
  return { rake, payouts, dust: distributable - paid };
}

/** Decimal payout multiple for one side if the pool closed now, net of rake. */
export function payoutMultiple(sidePool: number, otherPool: number, rakeRate: number): number {
  const total = sidePool + otherPool;
  if (sidePool <= 0) return Infinity;
  return (total * (1 - rakeRate)) / sidePool;
}

/** American odds string from a decimal multiple, rounded to the nearest 5 like a sportsbook. */
export function americanOdds(multiple: number): string {
  if (!Number.isFinite(multiple)) return "+∞";
  const profit = multiple - 1;
  if (profit <= 0.01) return "-9999";
  if (profit >= 1) {
    return `+${Math.max(100, Math.round((profit * 100) / 5) * 5)}`;
  }
  const v = Math.min(9999, Math.round(100 / profit / 5) * 5);
  return `-${Math.max(100, v)}`;
}
