// Every tunable number in Camera Ready lives here.
// Edit freely; no logic lives in this file.

export const gameConfig = {
  /** Display name. Change it here and nowhere else. */
  appName: "Camera Ready",

  economy: {
    /** One-time "startup funds" grant. Never renewed. */
    startupFunds: 1000,
    /** THE PUBLISHER's cut of every pool at resolution (0.10 = 10%). */
    rakeRate: 0.1,
    /** House stake placed on EACH side of a new market so odds show immediately. */
    houseSeedPerSide: 50,
    minStake: 10,
    /** Quick-pick stake chips on the phone. "MAX" is always added. */
    stakeChips: [10, 50, 100, 250],
  },

  markets: {
    /** Default lifetime of an operator-created microbet, in minutes. */
    defaultMicroMinutes: 20,
    /** Default lifetime of an operator-created future, in days. */
    defaultFutureDays: 180,
    /** Closed-but-unresolved markets older than this are flagged in the admin console. */
    staleAfterHours: 3,
  },

  /**
   * Autopilot: house-run microbets that open and resolve on their own,
   * so the booth works when nobody is staffing it. Outcomes are drawn at
   * random with each template's stated probability ("peer review").
   */
  autopilot: {
    enabledByDefault: true,
    /** Keep at least this many autopilot markets open. */
    minOpen: 2,
    /** How long an autopilot market accepts bets. */
    openMinutes: 4,
    /** Delay between close and the random "review decision". */
    resolveDelaySeconds: 20,
    /** Only spawn new markets if a player acted within this window (saves database writes). */
    idleAfterMinutes: 15,
  },

  limits: {
    /** Per WebSocket connection (or per session token on the HTTP fallback). */
    perConnection: {
      joinsPerMinute: 2,
      betsPerMinute: 30,
      restoreAttemptsPerMinute: 5,
      messagesPerMinute: 120,
    },
    /** Global caps, so reconnecting does not bypass the per-connection limits. */
    global: {
      joinsPerMinute: 60,
      failedRestoresPerMinute: 30,
    },
    /** Daily SQLite rows-written budget (Cloudflare free tier: 100,000/day). */
    rowsWrittenDailyBudget: 100_000,
    /** Admin console warns above this share of the budget. */
    rowsWrittenWarnAt: 0.7,
  },

  realtime: {
    /** Coalesce public broadcasts to at most one per this many ms. */
    broadcastThrottleMs: 500,
    /** Polling interval used only while the WebSocket is down. */
    pollIntervalMs: 15_000,
    /** Max reconnect backoff. */
    maxReconnectMs: 10_000,
    /** Ticker length kept on the board. */
    tickerLength: 25,
    leaderboardSize: 8,
  },
} as const;

export type GameConfig = typeof gameConfig;
