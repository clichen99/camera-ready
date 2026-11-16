# Decisions

Design decisions the spec did not cover, one line of reasoning each. Newest at the bottom.

## Answered by Celia (Nov 16, 2026)

- **Rate limiting is per connection, plus global caps, never by IP.** Celia confirmed per-connection limiting fits the IRB framing. Global caps on joins (60/min) and failed slip restores (30/min) stop reconnect-to-bypass without touching IPs.
- **Session limit (Phase 2) is a loss limit.** Celia's choice.
- **"Resubmit" after a lost microbet (Phase 2) re-stakes on another open market**, the soonest-closing one of the same type. A microbet has no "next venue", so the nearest open market plays that role.
- **The repo is public** (GitHub Pages on a free plan needs it). That means config files, seed markets, and copy are public, so nothing sensitive may go in them.
- **Unattended booth is a core requirement.** It is implemented as autopilot markets (below), a self-serve board, and a phone-friendly operator console.
- **Grant top-ups stay as the spec describes**: a low-odds application with no extra mechanics, and the success rate lives in config. The point is that everyone loses in the end.

## Architecture

- **One Durable Object holds the entire game.** One object keeps all balances strongly consistent with no cross-object coordination, and 500 players is far below its ~1,000 requests/sec soft limit.
- **The economy engine is transport-free (`server/src/engine/`) and runs on a small SQL interface.** Tests run the exact same SQL on Node's built-in `node:sqlite`, so the economy is tested without the Workers runtime.
- **Player intents travel over the WebSocket, with an HTTP fallback.** Incoming WebSocket messages are billed 20:1 on the free tier, and conference Wi-Fi drops sockets.
- **The WebSocket Hibernation API with an auto-responded ping** keeps idle connections free of duration charges and keepalives from waking the object.
- **The DO caches players and live markets in memory.** It rebuilds them on wake, so leaderboards and broadcasts cost no SQLite row reads.
- **House seed stakes are stored on the market row, not as bet rows.** That saves about 6 row writes per market against the 100k/day free-tier budget.
- **Ledger has no index; bets have two (market, player).** Every index costs a row write per insert, so only queries that run at resolution or on "My bets" get one.
- **Public broadcasts are coalesced to at most one every 500 ms.** That keeps CPU per invocation well under the 10 ms free-tier limit while still meeting the 2 s board-update target (measured: ~520 ms).
- **A rows-written meter is persisted at most once a minute and shown in the admin console**, with a warning at 70% of the daily budget.
- **Platform logging is disabled in `wrangler.toml`** (`observability.enabled = false`). This matches the spec's "minimize platform request logging".

## Economy

- **The house seed competes for the pool like any stake.** The house gets its proportional share when its side wins, and that share is tracked as `house_payout`, separate from the displayed take.
- **The displayed take is rake + APC + registration + review credit only**, per the spec. The house's net (including seed results) is shown only in the admin console.
- **The rake applies to the whole pool, seed included. Integer rounding dust goes to the house as rake.** Payouts are floored, so the house is the only party that can gain from rounding.
- **Displayed odds are net of rake.** The number shown is what you would actually be paid if the pool closed now. That means both sides can show negative American odds, which is honest about the house edge.
- **American odds are rounded to the nearest 5 and clamped at ±9999**, the way sportsbooks display them.
- **Operator void refunds stakes in full.** Only unreported personal markets lose the rake on void (Phase 2), per the spec.
- **Only unresolved markets can be voided.** Voiding a resolved market would require clawing back payouts, which could push balances negative.
- **A winning bet whose payout is below its stake counts the difference toward `total_lost`.** This happens when nearly everyone backs the same side, and it feeds the VIP tiers in Phase 2.
- **Points are conserved and checked.** `Game.audit()` verifies balance = ledger sum for every player, house totals = house ledger, and ledger + escrow = grants. It runs in tests and at `/api/admin/audit`.

## Identity and security

- **There are no cookies.** The front end (github.io) and server (workers.dev) are different sites, so a "first-party" cookie would be third-party and blocked on phones. The session token lives in `localStorage` and is sent in a message or header.
- **The session token is separate from the slip code.** Restoring with a slip code on a new device mints a new token; both are stored only as SHA-256 hashes.
- **The slip code is 13 Crockford base32 characters (65 bits).** Input is normalized (dashes, case, O→0, I/L→1) so codes written on paper still work.
- **The slip code is kept in `localStorage` on the device that joined**, so My Slip can show it. The server never reveals it again.
- **Duplicate initials get a tag (`ABC`, `ABC·2`).** The tag is a per-initials counter, not a random number, so the first ABC keeps the clean name.
- **The admin secret is checked in the Worker with constant-time comparison.** The Worker then forwards to the object with a fresh header set, so client headers can never claim admin.
- **Admin-authored market text is stored on the market row.** It is operator input, not player input, it is validated (length, no control characters), and it is always rendered as text.
- **The CSP is injected into production HTML as a meta tag** because GitHub Pages cannot set headers. Inline style attributes are avoided so `style-src 'self'` holds.
- **WebSocket upgrades are checked against the allowed-origin list**, because CORS does not apply to WebSockets.

## Unattended booth

- **Autopilot markets** are house-run microbets drawn from `markets.seed.json → autopilot`. They open in staggered pairs, close after 4 minutes, and resolve by a random draw at each template's stated probability. The UI says so ("Decided by THE PUBLISHER's peer review process"), so the randomness is part of the joke rather than hidden.
- **Autopilot only spawns markets when a player acted in the last 15 minutes.** This saves database writes overnight and while nobody is at the booth.
- **Operator microbets close on their own at close time.** The admin console flags closed markets nobody has resolved after 3 hours.
- **The admin console is built for phones**, so markets can be resolved from a session room.
- **The board requests a screen wake lock** and reconnects on its own. It needs no interaction.

## Front end

- **Vanilla TypeScript with a 60-line DOM helper, no framework.** This keeps dependencies minimal, and all text goes through `textContent`.
- **The phone client re-renders only when data on the current screen changed.** Constant re-rendering broke keyboard focus and would disturb screen readers.
- **Initials entry is three arcade-style spinbuttons.** ▲/▼ and arrow keys cycle letters, typing a letter fills a slot and advances, and Enter submits. This makes it keyboard- and arcade-button-ready.
- **Stake entry uses chips and a ±10 stepper, not a number field.** This keeps the "no free-text input" rule airtight.
- **A local "about" link and fine print are on every phone screen, and the board shows "Points only" next to the QR code.**
- **Fake players and the load test refuse non-local targets**, so they cannot burn the production free-tier budget by accident.
