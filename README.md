# Camera Ready

A satirical points-only sportsbook where conference attendees bet worthless points on academic publishing outcomes. THE PUBLISHER is the house, and the house always wins. CHI 2027 Interactive Demo.

**No real money is involved anywhere.** Points have no value and cannot be bought, sold, won, or redeemed.

Status: **Phase 1 (core loop).** See [DECISIONS.md](DECISIONS.md) for design choices the spec left open.

---

## What's here

| Path | What it is |
|---|---|
| `config/game.config.ts` | Every tunable number: startup funds, rake, stake limits, autopilot timing, rate limits |
| `config/copy.en.json` | Every user-facing string, in the house voice |
| `config/markets.seed.json` | Seed microbets, futures, and autopilot templates |
| `config/initials-blocklist.json` | Three-letter strings players cannot use |
| `server/src/engine/` | The authoritative game: ledger, pools, odds, resolution. No Workers dependencies |
| `server/src/game-do.ts` | The one Durable Object: SQLite storage, WebSockets, rate limits, push |
| `server/src/index.ts` | Worker entry: origin checks, CORS, security headers, admin auth |
| `shared/protocol.ts` | Wire types and strict validators shared by server and clients |
| `web/` | Front end: phone client `/`, shared board `/board/`, operator console `/admin/` |
| `sim/fake-players.ts` | Fake players for local mode and load testing |
| `tests/` | Economy tests (run against real SQLite) |
| `scripts/` | One-command dev mode and the end-to-end check |

You can edit any file in `config/` without touching game logic.

## Setup

Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite` for tests and runs TypeScript directly).

```bash
npm install
```

npm may ask you to approve install scripts for `esbuild` and `workerd` (the build tool and the local Cloudflare runtime):

```bash
npm install-scripts approve esbuild workerd
```

## Run it locally (also the offline booth fallback)

```bash
npm run dev
```

This starts the game server (a local Durable Object with SQLite, via Wrangler), the front end, and 6 fake players. It prints the addresses:

- **Phone:** `http://<laptop-LAN-IP>:5173/`. Phones on the same Wi-Fi can scan the board's QR code.
- **Board:** `http://<laptop-LAN-IP>:5173/board/`. Open it via the LAN address, not `localhost`, so the QR code works for phones.
- **Operator console:** `http://<laptop-LAN-IP>:5173/admin/`. The admin secret is printed, and it is stored in `.dev.vars`, which is gitignored and generated on first run.

Options: `npm run dev -- --no-bots` or `npm run dev -- --bots 20`.

Local state persists in `.wrangler/state/`. Use **Reset everything** in the operator console to start fresh.

## Tests

```bash
npm test
```

Economy tests (20). They check that balances always equal ledger sums, payouts plus rake equal the pool, points are conserved under 600 random actions, a player cannot stake more than their balance, autopilot works, and input validation holds.

```bash
npm run test:e2e
```

End-to-end (21 checks) against the real Worker + Durable Object in local `workerd`. A board and two players run a full bet-and-resolve cycle, and the check asserts the board updates within 2 s. It also covers origin and admin refusal, slip-code restore, and the join rate limit.

```bash
npm run typecheck
```

## Deploying

The front end is static (GitHub Pages). The game server is a Cloudflare Worker with one Durable Object.

### 1. Game server (Cloudflare, free plan)

1. Create a free Cloudflare account and run `npx wrangler login`.
2. `ALLOWED_ORIGINS` in `wrangler.toml` is set to `https://clichen99.github.io`. Change it if the front end moves (origin only, no path; comma-separate several).
3. Set the admin secret (a long random string, 32+ characters). It is never stored in the repo:
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```
4. Deploy:
   ```bash
   npm run deploy:server
   ```
   Note the `https://camera-ready.<subdomain>.workers.dev` URL it prints.

### 2. Front end (GitHub Pages)

1. Push this repository to GitHub as a public repo.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables:** add `VITE_SERVER_URL` with the Worker URL from step 1. This is a public value, so it goes under Variables, not Secrets.
4. Push to `main`. The workflow runs a gitleaks secret scan, typechecks, runs tests, builds, and deploys.

### Secrets checklist

| Secret | Where | Used for |
|---|---|---|
| `ADMIN_SECRET` | `npx wrangler secret put ADMIN_SECRET` (production); `.dev.vars` (local, auto-generated) | Operator console |
| `VITE_SERVER_URL` | GitHub repo **variable** (not secret) | Tells the front end where the server is |

Nothing secret belongs in the repository. The CI secret scan fails the build if one appears.

## Running the booth

**Before the conference:**
- Open the operator console and click **Reset everything**. This clears test players and re-seeds markets from `markets.seed.json`.
- Edit `config/markets.seed.json` with the real session markets, then redeploy the server.

**At the booth:**
- Put `/board/` full screen on the shared display (F11). It needs no interaction, reconnects on its own, and asks the browser to keep the screen awake. The QR code always points at the phone client.
- Visitors scan, enter initials, and get 1,000 points of startup funds. The whole loop is designed to fit in under 5 minutes.

**When you are not at the booth:**
- **Autopilot** keeps two house-run microbets open at all times while players are active. They open, close after 4 minutes, and resolve by a random draw ("THE PUBLISHER's peer review process"), so the loop works with nobody staffing it. Toggle it in the operator console.
- Your own operator microbets close on schedule and wait for you. The console flags any that have waited more than 3 hours.
- The operator console works on a phone, so you can resolve from a session room.

## Resolving markets

In the operator console (`/admin/`):

- **✓ Resolve YES / ✗ Resolve NO**: one tap, no confirmation (built for live booth use). Winners split the pool minus THE PUBLISHER's 10% rake, players get a result notice on their phones, and the board updates within about a second.
- **Close**: stops new bets without resolving.
- **↺ Void**: refunds every stake in full (asks for confirmation).
- **New market**: microbets close in minutes, futures in days. Write the resolution source in the form.
- **Database writes today**: progress against the free tier's 100,000 rows/day. Above 70% it turns into a warning.

Resolution cannot be undone. A resolved market cannot be voided.

## Free-tier budget (Cloudflare Workers Free, checked Nov 16, 2026)

| Limit | Value | Expected at ~300 active players/day |
|---|---|---|
| Requests | 100,000/day | ~7,000 (WebSocket messages count 20:1) |
| Durable Object duration | 13,000 GB-s/day | ≤10,800 even if never idle; far less with hibernation |
| SQLite rows written | 100,000/day | **The binding limit.** About 13 rows per bet over its lifetime, so the ceiling is ~7,500 bets/day |
| SQLite rows read | 5,000,000/day | Low (state is cached in memory) |
| Storage | 5 GB/account | Trivial |

If a daily limit is exceeded, writes fail until 00:00 UTC (8 pm in Pittsburgh in May). The admin meter warns well before that. Never point fake players or load tests at production; the scripts refuse non-local targets.

## Privacy

The database holds initials, point balances, bets, and markets, and nothing else. There are no names, emails, affiliations, free text, IP addresses, user agents, or cookies. Slip codes and session tokens are stored only as SHA-256 hashes. Platform request logging is disabled in `wrangler.toml`. Cloudflare's network still sees connection metadata in transit, which the app cannot control.
