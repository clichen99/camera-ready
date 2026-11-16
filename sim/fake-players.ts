// Fake players that join and place random bets against a LOCAL server.
// Used by `npm run dev` and for load testing. Refuses non-local targets so it
// can never burn the production free-tier budget by accident.
//
//   node sim/fake-players.ts --count 6 --url ws://127.0.0.1:8787/ws --pace 1

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const COUNT = Number(arg("count", "6"));
const URL_ = arg("url", "ws://127.0.0.1:8787/ws");
const PACE = Number(arg("pace", "1")); // multiply to bet faster (load tests)
const QUIET = argv.includes("--quiet");

const host = new URL(URL_).hostname;
if (!/^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.)/.test(host)) {
  console.error(`Refusing to run fake players against non-local host ${host}.`);
  process.exit(1);
}

interface Market {
  id: number;
  state: string;
  closesAt: number;
}

const LETTERS = "ABCDEFGHIJKLMNOPRSTUVWY"; // skips a few letters to avoid most blocklist hits
const randInitials = () => Array.from({ length: 3 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");

let markets: Market[] = [];
let totalBets = 0;

function bot(n: number): void {
  let balance = 0;
  let joined = false;
  let rid = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ws = new WebSocket(URL_);
  const send = (m: object) => ws.readyState === 1 && ws.send(JSON.stringify({ ...m, rid: rid++ }));

  const loop = () => {
    timer = setTimeout(loop, (4000 + Math.random() * 11000) / PACE);
    if (!joined || balance < 10) return;
    const open = markets.filter((m) => m.state === "open" && m.closesAt > Date.now() + 2000);
    if (!open.length) return;
    const m = open[Math.floor(Math.random() * open.length)];
    const stake = Math.max(10, Math.min(balance, Math.round(balance * (0.05 + Math.random() * 0.2))));
    send({ t: "bet", marketId: m.id, side: Math.random() < 0.5 ? "yes" : "no", stake });
  };

  ws.onopen = () => send({ t: "join", initials: randInitials(), adult: true });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === "public") markets = msg.state.markets;
    else if (msg.t === "me") balance = msg.me.balance;
    else if (msg.t === "reply" && msg.ok && msg.data?.slip) {
      joined = true;
      balance = msg.data.me.balance;
      if (!QUIET) console.log(`bot ${n} joined as ${msg.data.me.name}`);
      loop();
    } else if (msg.t === "reply" && msg.ok && msg.data?.betId) totalBets++;
    else if (msg.t === "reply" && !msg.ok && !joined) setTimeout(() => send({ t: "join", initials: randInitials(), adult: true }), 1000);
    else if (msg.t === "reset") {
      joined = false;
      send({ t: "join", initials: randInitials(), adult: true });
    }
  };
  ws.onclose = () => {
    if (timer) clearTimeout(timer);
    setTimeout(() => bot(n), 2000 + Math.random() * 2000);
  };
  ws.onerror = () => {
    /* onclose handles reconnect */
  };
}

for (let i = 0; i < COUNT; i++) setTimeout(() => bot(i + 1), i * 400);
if (!QUIET) setInterval(() => console.log(`${COUNT} bots · ${totalBets} bets placed`), 30_000);
