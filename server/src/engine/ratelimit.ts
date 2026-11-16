// Fixed-window counters held in memory only. Nothing here is persisted or logged.

export class Window {
  private start = 0;
  private count = 0;
  constructor(private readonly perMinute: number) {}

  /** Returns true if the action is allowed (and counts it). */
  take(now: number): boolean {
    if (now - this.start >= 60_000) {
      this.start = now;
      this.count = 0;
    }
    if (this.count >= this.perMinute) return false;
    this.count++;
    return true;
  }
}

export interface ConnLimits {
  join: Window;
  bet: Window;
  restore: Window;
  msg: Window;
}

export function newConnLimits(cfg: {
  joinsPerMinute: number;
  betsPerMinute: number;
  restoreAttemptsPerMinute: number;
  messagesPerMinute: number;
}): ConnLimits {
  return {
    join: new Window(cfg.joinsPerMinute),
    bet: new Window(cfg.betsPerMinute),
    restore: new Window(cfg.restoreAttemptsPerMinute),
    msg: new Window(cfg.messagesPerMinute),
  };
}
