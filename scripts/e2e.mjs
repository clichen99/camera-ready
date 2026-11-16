// End-to-end check against the real Worker + Durable Object running locally
// in workerd. Covers the Phase 1 "done" criterion: two players and a board
// run a full bet-and-resolve cycle, and the board updates within 2 seconds.
//
//   npm run test:e2e

import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://e2e.test";
const SECRET = randomBytes(24).toString("hex");

rmSync(".wrangler/e2e-state", { recursive: true, force: true });
const server = spawn(
  "npx",
  [
    "wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", ".wrangler/e2e-state",
    "--var", `ADMIN_SECRET:${SECRET}`, "--var", `ALLOWED_ORIGINS:${ORIGIN}`, "--log-level", "warn",
  ],
  { shell: process.platform === "win32", stdio: ["ignore", "inherit", "inherit"] },
);

function stop(code) {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {
    /* gone */
  }
  process.exit(code);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

/** A WebSocket client with request/reply and a message log. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: ORIGIN } });
  const pending = new Map();
  const listeners = [];
  const log = [];
  let rid = 1;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    msg._at = Date.now();
    log.push(msg);
    if (msg.t === "reply" && pending.has(msg.rid)) {
      pending.get(msg.rid)(msg);
      pending.delete(msg.rid);
    }
    for (const l of [...listeners]) l(msg);
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return {
    ready,
    call(m) {
      const id = rid++;
      ws.send(JSON.stringify({ ...m, rid: id }));
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no reply to ${m.t}`)), 8000);
        pending.set(id, (msg) => (clearTimeout(t), res(msg)));
      });
    },
    /** Resolves with the first matching message, including ones already received unless fresh=true. */
    waitFor(pred, ms = 5000, fresh = false) {
      const past = fresh ? undefined : log.find(pred);
      if (past) return Promise.resolve(past);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("timeout")), ms);
        const l = (msg) => {
          if (pred(msg)) {
            clearTimeout(t);
            listeners.splice(listeners.indexOf(l), 1);
            res(msg);
          }
        };
        listeners.push(l);
      });
    },
    close: () => ws.close(),
  };
}

const admin = (path, body) =>
  fetch(`${BASE}/api/admin/${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: ORIGIN, authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    if (i > 120) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("Server up. Running end-to-end checks:");

  // Security surface
  check("foreign origin is refused", (await fetch(`${BASE}/api/state`, { headers: { origin: "http://evil.test" } })).status === 403);
  check(
    "wrong admin secret is refused",
    (await fetch(`${BASE}/api/admin/state`, { headers: { origin: ORIGIN, authorization: "Bearer nope" } })).status === 403,
  );
  const st = await fetch(`${BASE}/api/state`, { headers: { origin: ORIGIN } });
  check("CORS allows the front-end origin", st.headers.get("access-control-allow-origin") === ORIGIN);
  check("strict CSP header on API responses", (st.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));

  // Board + two players
  const board = client();
  const a = client();
  const b = client();
  await Promise.all([board.ready, a.ready, b.ready]);
  const firstPublic = await board.waitFor((m) => m.t === "public");
  const market = firstPublic.state.markets.find((m) => m.state === "open" && m.type === "micro");
  check("seeded markets are open", Boolean(market));

  const ja = await a.call({ t: "join", initials: "AAA", adult: true });
  const jb = await b.call({ t: "join", initials: "BBB", adult: true });
  check("player A joins with startup funds", ja.ok && ja.data.me.balance === 1000);
  check("slip code is 13 base32 chars", ja.ok && /^[0-9A-Z]{13}$/.test(ja.data.slip));
  check("player B joins", jb.ok);

  const over = await a.call({ t: "bet", marketId: market.id, side: "yes", stake: 5000 });
  check("cannot stake more than balance", !over.ok && over.error === "insufficient_funds");
  const junk = await a.call({ t: "bet", marketId: market.id, side: "yes", stake: 50, balance: 99999 });
  check("unexpected fields are rejected", !junk.ok && junk.error === "invalid");

  const betA = await a.call({ t: "bet", marketId: market.id, side: "yes", stake: 200 });
  const betB = await b.call({ t: "bet", marketId: market.id, side: "no", stake: 300 });
  check("both bets accepted", betA.ok && betB.ok);
  const seen = await board.waitFor((m) => m.t === "public" && m.state.ticker.some((t) => t.kind === "bet" && t.who === "BBB"));
  check("board ticker shows the bets", Boolean(seen));

  // Resolve from the admin console and time the board update.
  const t0 = Date.now();
  const resolvedOnBoard = board.waitFor((m) => m.t === "public" && m.state.markets.some((x) => x.id === market.id && x.state === "resolved"), 5000, true);
  const noticeA = a.waitFor((m) => m.t === "notice", 5000, true);
  const noticeB = b.waitFor((m) => m.t === "notice", 5000, true);
  const r = await admin("action", { action: "resolve", marketId: market.id, outcome: "yes" });
  check("admin resolve succeeds", r.ok);
  const upd = await resolvedOnBoard;
  const latency = upd._at - t0;
  check("board updates within 2 seconds", latency < 2000, `${latency} ms`);
  const [na, nb] = await Promise.all([noticeA, noticeB]);
  check("winner gets a result notice", na.notice.payout > 200, `paid ${na.notice.payout}`);
  check("loser gets a result notice", nb.notice.payout === 0);
  const after = await board.waitFor((m) => m.t === "public" && m.state.house.take > 0);
  check("THE PUBLISHER's take went up", after.state.house.take > 0, `take ${after.state.house.take}`);

  // Session restore by slip code on a new connection.
  const c = client();
  await c.ready;
  const pretty = ja.data.slip.replace(/(.{4})(.{4})(.{5})/, "$1-$2-$3").toLowerCase();
  const restored = await c.call({ t: "restore", slip: pretty });
  check("slip code restores the session elsewhere", restored.ok && restored.data.me.id === ja.data.me.id);
  const bad = await c.call({ t: "restore", slip: "0000-0000-00000" });
  check("wrong slip code fails", !bad.ok);

  // Per-connection rate limit on joins (config: 2/minute).
  const d = client();
  await d.ready;
  const j1 = await d.call({ t: "join", initials: "DDA", adult: true });
  const j2 = await d.call({ t: "join", initials: "DDB", adult: true });
  const j3 = await d.call({ t: "join", initials: "DDC", adult: true });
  check("join rate limit per connection", j1.ok && j2.ok && !j3.ok && j3.error === "rate_limited");

  const audit = await (await admin("audit")).json();
  check("ledger audit passes on the live server", audit.ok, audit.problems?.join("; "));

  for (const x of [board, a, b, c, d]) x.close();
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll end-to-end checks passed.");
    stop(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    stop(1);
  });
