// Phone client. Renders server state; sends intents. No free-text input
// exists here except the slip code field, which is a credential checked
// against a strict character set.

import copy from "../../config/copy.en.json";
import { gameConfig } from "../../config/game.config";
import {
  formatSlip,
  normalizeSlip,
  type JoinResult,
  type MarketView,
  type MeState,
  type PublicState,
  type ResultNotice,
  type Side,
} from "../../shared/protocol";
import { countdown, fmt, h, pts, replace, store } from "./dom";
import { Connection, RequestError } from "./net";
import "./styles.css";

type Screen = "join" | "reveal" | "home" | "market" | "bets" | "slip" | "about";

const SLIP_KEY = "cr.slip";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const ui = {
  screen: "join" as Screen,
  pub: null as PublicState | null,
  me: null as MeState | null,
  clockOffset: 0,
  online: true,
  initials: [0, 0, 0],
  adult: false,
  revealSlip: "",
  marketId: 0,
  side: "yes" as Side,
  stake: 50,
  message: "",
  busy: false,
  toast: null as ResultNotice | null,
  slipDraft: "",
};

const root = document.getElementById("app")!;
const conn = new Connection(
  {
    onPublic(s) {
      ui.pub = s;
      ui.clockOffset = s.now - Date.now();
      // Only rebuild when the visible content changed; constant rebuilding
      // would disturb screen readers and keyboard users.
      const digest = visibleDigest();
      if (digest !== lastDigest) {
        lastDigest = digest;
        render();
      }
    },
    onMe(m) {
      ui.me = m;
      if (ui.screen === "join") ui.screen = "home";
      render();
    },
    onNotice(n) {
      ui.toast = n;
      render();
    },
    onReset() {
      ui.me = null;
      store.del(SLIP_KEY);
      go("join");
    },
    onSignedOut() {
      ui.me = null;
      go("join");
    },
    onStatus(online) {
      ui.online = online;
      render();
    },
  },
  true,
);

let lastDigest = "";

/** A fingerprint of the live data the current screen displays. */
function visibleDigest(): string {
  const markets = ui.pub?.markets ?? [];
  const pick = (m: (typeof markets)[number]) => [m.id, m.state, m.oddsYes, m.oddsNo, m.poolYes, m.poolNo, m.outcome];
  if (ui.screen === "home") return `home:${JSON.stringify(markets.map(pick))}`;
  if (ui.screen === "market") return `market:${JSON.stringify(markets.filter((m) => m.id === ui.marketId).map(pick))}`;
  return ui.screen;
}

function now(): number {
  return Date.now() + ui.clockOffset;
}

function go(s: Screen): void {
  ui.screen = s;
  ui.message = "";
  render();
  window.scrollTo(0, 0);
  // Move focus to the new screen's heading for keyboard and screen-reader users.
  requestAnimationFrame(() => root.querySelector<HTMLElement>("h1, h2")?.focus());
}

function errorText(e: unknown): string {
  const code = e instanceof RequestError ? e.code : "internal";
  switch (code) {
    case "blocked_initials":
      return copy.join.blocked;
    case "invalid":
      return copy.join.invalid;
    case "insufficient_funds":
      return copy.bet.insufficient;
    case "below_min":
      return fmt(copy.bet.belowMin, { min: gameConfig.economy.minStake });
    case "market_closed":
    case "no_market":
      return copy.bet.closed;
    case "rate_limited":
      return copy.bet.rateLimited;
    case "restore_failed":
      return copy.slip.restoreFailed;
    case "not_authenticated":
      return copy.errors.notJoined;
    default:
      return copy.errors.generic;
  }
}

// ------------------------------------------------------------------ render

/** Re-renders the current screen, keeping keyboard focus on the same control. */
function render(): void {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  replace(
    root,
    header(),
    !ui.online ? h("p", { class: "offline", role: "status" }, copy.errors.offline) : null,
    h("main", { id: "main" }, screen()),
    ui.me && ui.screen !== "reveal" ? nav() : null,
    footer(),
    ui.toast ? toast(ui.toast) : null,
  );
  if (focusKey) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function header(): HTMLElement {
  return h(
    "header",
    { class: "top" },
    h("div", { class: "wordmark", "aria-label": gameConfig.appName }, h("span", { class: "mark-dot", "aria-hidden": "true" }), gameConfig.appName.toUpperCase()),
    ui.me
      ? h(
          "div",
          { class: "balance", "aria-label": `${copy.home.balance} ${ui.me.balance} points` },
          h("span", { class: "who" }, ui.me.name),
          h("span", { class: "amt" }, pts(ui.me.balance), " ", copy.pointsName),
        )
      : null,
  );
}

function nav(): HTMLElement {
  const item = (s: Screen, label: string) =>
    h(
      "button",
      {
        class: "tab",
        "data-key": `nav-${s}`,
        "aria-current": ui.screen === s || (s === "home" && ui.screen === "market") ? "page" : null,
        onclick: () => go(s),
      },
      label,
    );
  return h(
    "nav",
    { class: "tabs", "aria-label": "Sections" },
    item("home", copy.nav.home),
    item("bets", copy.nav.bets),
    item("slip", copy.nav.slip),
  );
}

function footer(): HTMLElement {
  return h(
    "footer",
    { class: "fine" },
    h("button", { class: "linklike", "data-key": "about", onclick: () => go("about") }, copy.nav.about),
    h("p", {}, copy.noMoney),
    h("p", {}, copy.finePrint),
  );
}

function screen(): HTMLElement | HTMLElement[] {
  switch (ui.screen) {
    case "join":
      return joinScreen();
    case "reveal":
      return revealScreen();
    case "home":
      return homeScreen();
    case "market":
      return marketScreen();
    case "bets":
      return betsScreen();
    case "slip":
      return slipScreen();
    case "about":
      return aboutScreen();
  }
}

// ------------------------------------------------------------------ join

function joinScreen(): HTMLElement[] {
  const slot = (i: number) => {
    const letter = LETTERS[ui.initials[i]];
    const bump = (d: number) => {
      ui.initials[i] = (ui.initials[i] + d + 26) % 26;
      render();
    };
    return h(
      "div",
      { class: "slot" },
      h("button", { class: "arrow", "aria-label": `Next letter for initial ${i + 1}`, "data-key": `up${i}`, onclick: () => bump(1) }, "▲"),
      h(
        "div",
        {
          class: "letter",
          role: "spinbutton",
          tabindex: 0,
          "data-key": `slot${i}`,
          "aria-label": `Initial ${i + 1}`,
          "aria-valuetext": letter,
          "aria-valuenow": ui.initials[i],
          "aria-valuemin": 0,
          "aria-valuemax": 25,
          onkeydown: (e: Event) => {
            const k = (e as KeyboardEvent).key;
            if (k === "ArrowUp") bump(1);
            else if (k === "ArrowDown") bump(-1);
            else if (k === "ArrowRight" && i < 2) focusKey(`slot${i + 1}`);
            else if (k === "ArrowLeft" && i > 0) focusKey(`slot${i - 1}`);
            else if (k === "Enter") void submitJoin();
            else if (/^[a-z]$/i.test(k)) {
              ui.initials[i] = LETTERS.indexOf(k.toUpperCase());
              render();
              focusKey(i < 2 ? `slot${i + 1}` : "adult");
            } else return;
            e.preventDefault();
          },
        },
        letter,
      ),
      h("button", { class: "arrow", "aria-label": `Previous letter for initial ${i + 1}`, "data-key": `down${i}`, onclick: () => bump(-1) }, "▼"),
    );
  };
  return [
    h("h1", { class: "arcade", tabindex: -1 }, copy.join.title),
    h("p", { class: "sub" }, copy.join.subtitle),
    h("div", { class: "slots" }, slot(0), slot(1), slot(2)),
    h("p", { class: "hint" }, copy.join.hint),
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        "data-key": "adult",
        checked: ui.adult,
        onchange: (e: Event) => {
          ui.adult = (e.target as HTMLInputElement).checked;
          render();
        },
      }),
      " ",
      copy.join.ageConfirm,
    ),
    h("p", { class: "note" }, copy.noMoney),
    h(
      "button",
      { class: "primary big", "data-key": "join", disabled: !ui.adult || ui.busy, onclick: () => void submitJoin() },
      copy.join.submit,
    ),
    message(),
    h("hr"),
    h("h2", {}, copy.slip.restoreTitle),
    restoreForm(),
  ];
}

/** Moves focus immediately (render() is synchronous), so fast typing lands in the right slot. */
function focusKey(k: string): void {
  root.querySelector<HTMLElement>(`[data-key="${k}"]`)?.focus();
}

async function submitJoin(): Promise<void> {
  if (!ui.adult || ui.busy) return;
  ui.busy = true;
  ui.message = "";
  render();
  try {
    const initials = ui.initials.map((i) => LETTERS[i]).join("");
    const r = await conn.call<JoinResult>({ t: "join", initials, adult: true });
    conn.setToken(r.token);
    store.set(SLIP_KEY, r.slip);
    ui.me = r.me;
    ui.revealSlip = r.slip;
    ui.busy = false;
    go("reveal");
  } catch (e) {
    ui.busy = false;
    ui.message = errorText(e);
    render();
  }
}

function revealScreen(): HTMLElement[] {
  return [
    h("h1", { class: "arcade", tabindex: -1 }, copy.slip.title),
    h("p", { class: "win-text" }, "✓ ", copy.join.welcome),
    h("p", { class: "slipcode", "aria-label": `Slip code ${ui.revealSlip.split("").join(" ")}` }, formatSlip(ui.revealSlip)),
    h("p", { class: "warn" }, "⚠ ", copy.slip.warning),
    h("p", {}, copy.slip.explain),
    h("button", { class: "primary big", "data-key": "saved", onclick: () => go("home") }, copy.slip.continue),
  ];
}

function restoreForm(): HTMLElement {
  return h(
    "form",
    {
      class: "restore",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).elements.namedItem("slip") as HTMLInputElement;
        const slip = normalizeSlip(input.value);
        if (!slip) {
          ui.message = copy.slip.restoreFailed;
          return render();
        }
        try {
          const r = await conn.call<{ token: string; me: MeState }>({ t: "restore", slip });
          conn.setToken(r.token);
          store.set(SLIP_KEY, slip);
          ui.me = r.me;
          go("home");
        } catch (err) {
          ui.message = errorText(err);
          render();
        }
      },
    },
    h("label", { for: "slip" }, copy.slip.restoreHint),
    h("input", {
      id: "slip",
      name: "slip",
      "data-key": "slip",
      inputmode: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      maxlength: 16,
      placeholder: "XXXX-XXXX-XXXXX",
      pattern: "[0-9A-Za-z\\- ]{13,16}",
      value: ui.slipDraft,
      // Keep the draft across re-renders caused by live updates.
      oninput: (e: Event) => (ui.slipDraft = (e.target as HTMLInputElement).value),
    }),
    h("button", { class: "secondary", "data-key": "restore", type: "submit" }, copy.slip.restoreSubmit),
  );
}

function message(): HTMLElement {
  return h("p", { class: "msg", role: "status", "aria-live": "polite" }, ui.message);
}

// ------------------------------------------------------------------ markets

function homeScreen(): HTMLElement[] {
  const markets = ui.pub?.markets ?? [];
  const open = markets.filter((m) => m.state === "open");
  const micro = open.filter((m) => m.type === "micro");
  const futures = open.filter((m) => m.type === "future");
  const settled = markets.filter((m) => m.state !== "open").slice(0, 5);
  return [
    h("h1", { class: "visually-hidden", tabindex: -1 }, copy.nav.home),
    section(copy.home.live, micro),
    section(copy.home.futures, futures),
    !open.length ? h("p", { class: "note" }, copy.home.empty) : null,
    settled.length ? h("h2", { class: "sect" }, "RECENT DECISIONS") : null,
    h("ul", { class: "results" }, settled.map(resultRow)),
  ].filter(Boolean) as HTMLElement[];
}

function section(title: string, list: MarketView[]): HTMLElement | null {
  if (!list.length) return null;
  return h("section", {}, h("h2", { class: "sect" }, title), h("ul", { class: "cards" }, list.map(card)));
}

function card(m: MarketView): HTMLElement {
  const left = m.closesAt - now();
  return h(
    "li",
    {},
    h(
      "button",
      {
        class: "card",
        "data-key": `m${m.id}`,
        onclick: () => {
          ui.marketId = m.id;
          ui.side = "yes";
          ui.stake = Math.min(50, ui.me?.balance ?? 50);
          go("market");
        },
      },
      h("span", { class: "q" }, m.question),
      h(
        "span",
        { class: "odds-row" },
        h("span", { class: "odds yes" }, `${copy.bet.yes} ${m.oddsYes}`),
        h("span", { class: "odds no" }, `${copy.bet.no} ${m.oddsNo}`),
      ),
      h(
        "span",
        { class: "meta" },
        `${copy.home.pool} ${pts(m.poolYes + m.poolNo)} · ${copy.home.closesIn} `,
        h("span", { "data-countdown": m.closesAt }, countdown(left)),
        m.auto ? ` · ${copy.home.autopilotNote}` : "",
      ),
    ),
  );
}

function resultRow(m: MarketView): HTMLElement {
  const label =
    m.state === "void" ? `↺ ${copy.result.void}` : m.state === "resolved" ? `→ ${m.outcome === "yes" ? copy.bet.yes : copy.bet.no}` : copy.home.closed;
  return h("li", {}, h("span", { class: "q" }, m.question), h("span", { class: "tag" }, label));
}

function marketScreen(): HTMLElement[] {
  const m = ui.pub?.markets.find((x) => x.id === ui.marketId);
  const back = h("button", { class: "back", "data-key": "back", onclick: () => go("home") }, "← ", copy.nav.home);
  if (!m) return [back, h("p", {}, copy.bet.closed)];
  const balance = ui.me?.balance ?? 0;
  const open = m.state === "open" && m.closesAt > now();
  const setStake = (v: number) => {
    ui.stake = Math.max(gameConfig.economy.minStake, Math.min(balance, v));
    render();
  };
  const sideBtn = (s: Side) =>
    h(
      "button",
      {
        class: `side ${s}`,
        "data-key": `side-${s}`,
        "aria-pressed": ui.side === s ? "true" : "false",
        onclick: () => {
          ui.side = s;
          render();
        },
      },
      h("span", { class: "side-label" }, s === "yes" ? copy.bet.yes : copy.bet.no),
      h("span", { class: "side-odds" }, s === "yes" ? m.oddsYes : m.oddsNo),
      h("span", { class: "side-pool" }, `${pts(s === "yes" ? m.poolYes : m.poolNo)} ${copy.pointsName}`),
    );
  return [
    back,
    h("h1", { class: "question", tabindex: -1 }, m.question),
    h("p", { class: "meta" }, m.sourceNote),
    h(
      "p",
      { class: "meta" },
      `${copy.home.pool} ${pts(m.poolYes + m.poolNo)} ${copy.pointsName} · ${copy.home.closesIn} `,
      h("span", { "data-countdown": m.closesAt }, countdown(m.closesAt - now())),
    ),
    h("div", { class: "sides", role: "group", "aria-label": "Pick a side" }, sideBtn("yes"), sideBtn("no")),
    h("h2", { class: "sect" }, copy.bet.stake),
    h(
      "div",
      { class: "stake" },
      h("button", { class: "step", "aria-label": "Decrease stake by 10", "data-key": "minus", onclick: () => setStake(ui.stake - 10) }, "−"),
      h("output", { class: "stake-amt", "aria-live": "polite" }, `${pts(ui.stake)} ${copy.pointsName}`),
      h("button", { class: "step", "aria-label": "Increase stake by 10", "data-key": "plus", onclick: () => setStake(ui.stake + 10) }, "+"),
    ),
    h(
      "div",
      { class: "chips" },
      [...gameConfig.economy.stakeChips].map((c) =>
        h("button", { class: "chip", "data-key": `chip${c}`, disabled: c > balance, onclick: () => setStake(c) }, String(c)),
      ),
      h("button", { class: "chip max", "data-key": "chipmax", disabled: balance < gameConfig.economy.minStake, onclick: () => setStake(balance) }, copy.bet.max),
    ),
    h(
      "button",
      {
        class: "primary big",
        "data-key": "confirm",
        disabled: !open || ui.busy || balance < gameConfig.economy.minStake || ui.stake > balance,
        onclick: () => void placeBet(m.id),
      },
      `${copy.bet.confirm}: ${pts(ui.stake)} ON ${ui.side === "yes" ? copy.bet.yes : copy.bet.no}`,
    ),
    !open ? h("p", { class: "note" }, copy.bet.closed) : null,
    balance < gameConfig.economy.minStake ? h("p", { class: "note" }, copy.bet.insufficient) : null,
    message(),
  ].filter(Boolean) as HTMLElement[];
}

async function placeBet(marketId: number): Promise<void> {
  ui.busy = true;
  render();
  try {
    await conn.call({ t: "bet", marketId, side: ui.side, stake: ui.stake });
    ui.message = `✓ ${copy.bet.placed}`;
  } catch (e) {
    ui.message = `✗ ${errorText(e)}`;
  }
  ui.busy = false;
  render();
}

// ------------------------------------------------------------------ bets / slip / about

function betsScreen(): HTMLElement[] {
  const bets = ui.me?.bets ?? [];
  const open = bets.filter((b) => b.state === "open");
  const done = bets.filter((b) => b.state !== "open");
  const row = (b: (typeof bets)[number]) => {
    const icon = b.state === "won" ? "✓" : b.state === "lost" ? "✗" : b.state === "void" ? "↺" : "…";
    const label =
      b.state === "won" ? copy.result.won : b.state === "lost" ? copy.result.lost : b.state === "void" ? copy.result.void : copy.bets.open;
    return h(
      "li",
      { class: `bet ${b.state}` },
      h("span", { class: "q" }, b.question),
      h(
        "span",
        { class: "meta" },
        `${pts(b.stake)} on ${b.side === "yes" ? copy.bet.yes : copy.bet.no}`,
        b.payout !== null && b.state !== "open" ? ` → ${pts(b.payout)}` : "",
      ),
      h("span", { class: "tag" }, `${icon} ${label}`),
    );
  };
  return [
    h("h1", { tabindex: -1 }, copy.nav.bets),
    h("h2", { class: "sect" }, copy.bets.open),
    open.length ? h("ul", { class: "betlist" }, open.map(row)) : h("p", { class: "note" }, copy.bets.none),
    h("h2", { class: "sect" }, copy.bets.history),
    h("ul", { class: "betlist" }, done.map(row)),
  ];
}

function slipScreen(): HTMLElement[] {
  const slip = store.get(SLIP_KEY);
  return [
    h("h1", { tabindex: -1 }, copy.slip.title),
    slip ? h("p", { class: "slipcode" }, formatSlip(slip)) : h("p", { class: "note" }, copy.slip.notOnThisDevice),
    h("p", {}, copy.slip.explain),
    h("p", { class: "meta" }, window.location.origin + window.location.pathname),
    h("hr"),
    h("h2", {}, copy.slip.restoreTitle),
    restoreForm(),
    message(),
  ];
}

function aboutScreen(): HTMLElement[] {
  return [
    h("button", { class: "back", "data-key": "back", onclick: () => go(ui.me ? "home" : "join") }, "← Back"),
    h("h1", { tabindex: -1 }, copy.about.title),
    copy.about.body.map((p) => h("p", {}, p)),
    h("h2", {}, copy.about.supportTitle),
    h(
      "ul",
      {},
      copy.about.supportLinks.map((l) => h("li", {}, h("a", { href: l.href, rel: "noopener noreferrer", target: "_blank" }, l.label))),
    ),
  ].flat();
}

function toast(n: ResultNotice): HTMLElement {
  const kind = n.outcome === "void" ? "void" : n.side === n.outcome ? "won" : "lost";
  const title = kind === "won" ? `✓ ${copy.result.won}` : kind === "lost" ? `✗ ${copy.result.lost}` : `↺ ${copy.result.void}`;
  const detail =
    kind === "won"
      ? fmt(copy.result.wonDetail, { payout: pts(n.payout), stake: pts(n.stake) })
      : kind === "lost"
        ? fmt(copy.result.lostDetail, { stake: pts(n.stake) })
        : fmt(copy.result.voidDetail, { stake: pts(n.stake) });
  return h(
    "div",
    { class: `toast ${kind}`, role: "status", "aria-live": "assertive" },
    h("p", { class: "toast-title" }, title),
    h("p", { class: "q" }, n.question),
    h("p", {}, detail),
    h(
      "button",
      {
        class: "secondary",
        "data-key": "toast-ok",
        onclick: () => {
          ui.toast = null;
          render();
        },
      },
      "OK",
    ),
  );
}

// ------------------------------------------------------------------ boot

// Countdown text ticks locally between server updates (display only).
setInterval(() => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-countdown]")) {
    el.textContent = countdown(Number(el.dataset.countdown) - now());
  }
}, 1000);

if (!conn.token) ui.screen = "join";
render();
conn.start();
