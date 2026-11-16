// Shared screen. Landscape, readable from 3 m, no interaction needed.
// Designed to run unattended: reconnects on its own and keeps the screen awake.

import copy from "../../config/copy.en.json";
import { gameConfig } from "../../config/game.config";
import type { MarketView, PublicState, TickerItem } from "../../shared/protocol";
import { countdown, fmt, h, pts, reducedMotion, replace } from "./dom";
import { Connection } from "./net";
import { qrSvg } from "./qr";
import "./styles.css";

document.body.classList.add("board");
const root = document.getElementById("app")!;

let pub: PublicState | null = null;
let clockOffset = 0;
let online = false;
let shownTake = 0;
let targetTake = 0;

// The join URL is the phone client: same origin and base path as this page, minus "board/".
const joinUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();

const takeEl = h("span", { class: "take-num" }, "0");
const statusEl = h("p", { class: "offline", role: "status" });
const leadersEl = h("ol", { class: "leaders" });
const featuredEl = h("div", { class: "featured" });
const tickerEl = h("ul", { class: "ticker", "aria-live": "off" });

replace(
  root,
  h(
    "div",
    { class: "board-grid" },
    h(
      "header",
      { class: "board-head" },
      h("div", { class: "wordmark xl" }, h("span", { class: "mark-dot", "aria-hidden": "true" }), gameConfig.appName.toUpperCase()),
      h("p", { class: "tagline" }, copy.tagline),
      statusEl,
    ),
    h(
      "section",
      { class: "panel left", "aria-label": copy.board.leaders },
      h(
        "div",
        { class: "house-row" },
        h("span", { class: "rank" }, "#0"),
        h("span", { class: "house-name" }, copy.house),
        h("span", { class: "take" }, h("span", { class: "take-label" }, copy.board.take), takeEl),
      ),
      h("h2", { class: "sect" }, copy.board.leaders),
      leadersEl,
    ),
    h("section", { class: "panel center", "aria-label": copy.board.featured }, h("h2", { class: "sect" }, copy.board.featured), featuredEl),
    h("section", { class: "panel right", "aria-label": copy.board.ticker }, h("h2", { class: "sect" }, copy.board.ticker), tickerEl),
    h(
      "aside",
      { class: "panel qr" },
      h("div", { class: "qr-box" }, qrSvg(joinUrl, `QR code to join: ${joinUrl}`)),
      h("p", { class: "scan" }, copy.board.scan),
      h("p", { class: "url" }, joinUrl.replace(/^https?:\/\//, "")),
      h("p", { class: "self" }, copy.board.selfServe),
      h("p", { class: "fine-board" }, copy.noMoney),
    ),
  ),
);

function now(): number {
  return Date.now() + clockOffset;
}

function renderLeaders(s: PublicState): void {
  replace(
    leadersEl,
    s.leaders.map((l, i) =>
      h("li", {}, h("span", { class: "rank" }, `#${i + 1}`), h("span", { class: "name" }, l.name), h("span", { class: "bal" }, pts(l.balance))),
    ),
    !s.leaders.length ? h("li", { class: "empty" }, "—") : null,
  );
}

function renderFeatured(s: PublicState): void {
  const m: MarketView | undefined = s.markets.find((x) => x.id === s.featuredId);
  if (!m) return replace(featuredEl, h("p", { class: "q big" }, copy.home.empty));
  const total = Math.max(1, m.poolYes + m.poolNo);
  const yesPct = Math.round((m.poolYes / total) * 100);
  // Set through the CSSOM: the CSP forbids inline style attributes.
  const yesBar = h("span", { class: "bar-yes" });
  yesBar.style.width = `${yesPct}%`;
  replace(
    featuredEl,
    h("p", { class: "q big" }, m.question),
    h(
      "div",
      { class: "bar", role: "img", "aria-label": `YES ${yesPct}% of pool, NO ${100 - yesPct}%` },
      yesBar,
    ),
    h(
      "div",
      { class: "feat-odds" },
      h("span", { class: "odds yes xl" }, `${copy.bet.yes} ${m.oddsYes}`),
      h("span", { class: "odds no xl" }, `${copy.bet.no} ${m.oddsNo}`),
    ),
    h(
      "p",
      { class: "meta big" },
      `${copy.home.pool} ${pts(m.poolYes + m.poolNo)} ${copy.pointsName} · ${copy.home.closesIn} `,
      h("span", { "data-countdown": m.closesAt }, countdown(m.closesAt - now())),
    ),
    m.auto ? h("p", { class: "meta" }, copy.home.autopilotNote) : null,
  );
}

function tickerText(t: TickerItem): { text: string; cls: string; icon: string } {
  switch (t.kind) {
    case "bet":
      return {
        text: fmt(copy.board.staked, { who: t.who ?? "", stake: pts(t.stake ?? 0), side: t.side === "yes" ? copy.bet.yes : copy.bet.no }),
        cls: "t-bet",
        icon: "▸",
      };
    case "join":
      return { text: fmt(copy.board.joined, { who: t.who ?? "" }), cls: "t-join", icon: "+" };
    case "resolved":
      return {
        text: fmt(copy.board.resolved, { question: t.question ?? "", outcome: t.outcome === "yes" ? copy.bet.yes : copy.bet.no }),
        cls: "t-res",
        icon: "■",
      };
    case "void":
      return { text: fmt(copy.board.voided, { question: t.question ?? "" }), cls: "t-void", icon: "↺" };
  }
}

function renderTicker(s: PublicState): void {
  replace(
    tickerEl,
    s.ticker.slice(0, 14).map((t) => {
      const { text, cls, icon } = tickerText(t);
      return h("li", { class: cls }, h("span", { class: "icon", "aria-hidden": "true" }, icon), text);
    }),
  );
}

function animateTake(): void {
  if (reducedMotion() || Math.abs(targetTake - shownTake) < 1) {
    shownTake = targetTake;
  } else {
    shownTake += Math.ceil((targetTake - shownTake) / 8);
  }
  takeEl.textContent = pts(shownTake);
  requestAnimationFrame(animateTake);
}
requestAnimationFrame(animateTake);

function renderStatus(): void {
  statusEl.textContent = online ? "" : copy.board.offline;
}

const conn = new Connection(
  {
    onPublic(s) {
      pub = s;
      clockOffset = s.now - Date.now();
      targetTake = s.house.take;
      renderLeaders(s);
      renderFeatured(s);
      renderTicker(s);
    },
    onStatus(v) {
      online = v;
      renderStatus();
    },
  },
  false,
);
renderStatus();
conn.start();

setInterval(() => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-countdown]")) {
    el.textContent = countdown(Number(el.dataset.countdown) - now());
  }
  if (pub) document.body.dataset.players = String(pub.players);
}, 1000);

// Keep the display awake while the board is visible (where supported).
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<unknown> } };
    await nav.wakeLock?.request("screen");
  } catch {
    /* not supported or denied: the OS power settings apply */
  }
}
void keepAwake();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void keepAwake();
});
