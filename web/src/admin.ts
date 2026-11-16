// Operator console. Works on a phone so markets can be resolved from a
// session room. The admin secret is kept in sessionStorage for this tab only.

import { gameConfig } from "../../config/game.config";
import type { AdminAction, AdminMarket, AdminState } from "../../shared/protocol";
import { countdown, h, pts, replace } from "./dom";
import { Connection, httpBase } from "./net";
import "./styles.css";

const root = document.getElementById("app")!;
const KEY = "cr.admin";
let state: AdminState | null = null;
let msg = "";
let refreshTimer: number | null = null;

function secret(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function setSecret(v: string | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

async function api(path: string, body?: AdminAction): Promise<unknown> {
  const res = await fetch(`${httpBase()}/api/admin/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${secret()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) {
    setSecret(null);
    msg = "Wrong admin secret.";
    render();
    throw new Error(msg);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; state?: AdminState };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function refresh(): Promise<void> {
  // While locked, leave the login form alone so a half-typed secret is not wiped.
  if (!secret()) return;
  try {
    state = (await api("state")) as AdminState;
  } catch (e) {
    msg = (e as Error).message;
  }
  render();
}

/** Refreshes at most every 2 s when live updates arrive, plus once a minute. */
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 2000);
}

async function act(a: AdminAction, confirmText?: string): Promise<void> {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    const r = (await api("action", a)) as { state?: AdminState };
    if (r.state) state = r.state;
    msg = `✓ ${a.action} done`;
  } catch (e) {
    msg = `✗ ${(e as Error).message}`;
  }
  render();
}

function login(): HTMLElement {
  return h(
    "form",
    {
      class: "admin-login",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const v = ((e.target as HTMLFormElement).elements.namedItem("secret") as HTMLInputElement).value.trim();
        setSecret(v);
        void refresh();
      },
    },
    h("h1", {}, "Operator console"),
    h("label", { for: "secret" }, "Admin secret"),
    h("input", { id: "secret", name: "secret", type: "password", autocomplete: "off", required: true }),
    h("button", { class: "primary", type: "submit" }, "Unlock"),
    h("p", { class: "msg", role: "status" }, msg),
  );
}

function marketRow(m: AdminMarket): HTMLElement {
  const live = m.state === "open" || m.state === "closed";
  const when = m.state === "open" ? `closes in ${countdown(m.closesAt - (state?.now ?? Date.now()))}` : m.state;
  return h(
    "li",
    { class: `admin-market ${m.state}${m.stale ? " stale" : ""}` },
    h("p", { class: "q" }, `#${m.id} · ${m.question}`),
    h(
      "p",
      { class: "meta" },
      `${m.type}${m.auto ? " · autopilot" : ""} · ${when} · ${m.betCount} bets · YES ${pts(m.poolYes)} / NO ${pts(m.poolNo)}`,
      m.outcome ? ` · outcome ${m.outcome.toUpperCase()}` : "",
      m.stale ? " · ⚠ waiting for you" : "",
    ),
    live
      ? h(
          "div",
          { class: "admin-actions" },
          h("button", { class: "resolve yes", onclick: () => void act({ action: "resolve", marketId: m.id, outcome: "yes" }) }, "✓ Resolve YES"),
          h("button", { class: "resolve no", onclick: () => void act({ action: "resolve", marketId: m.id, outcome: "no" }) }, "✗ Resolve NO"),
          m.state === "open" ? h("button", { class: "secondary", onclick: () => void act({ action: "close", marketId: m.id }) }, "Close") : null,
          h(
            "button",
            { class: "secondary", onclick: () => void act({ action: "void", marketId: m.id }, `Void market #${m.id} and refund all stakes?`) },
            "↺ Void",
          ),
        )
      : null,
  );
}

function createForm(): HTMLElement {
  return h(
    "form",
    {
      class: "admin-create",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const f = e.target as HTMLFormElement;
        const get = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
        const type = get("type") as "micro" | "future";
        const amount = Number(get("amount"));
        const closesInMinutes = type === "micro" ? amount : amount * 24 * 60;
        void act({ action: "create", type, question: get("question").trim(), closesInMinutes, sourceNote: get("source").trim() }).then(() =>
          f.reset(),
        );
      },
    },
    h("h2", {}, "New market"),
    h("label", { for: "type" }, "Type"),
    h("select", { id: "type", name: "type" }, h("option", { value: "micro" }, "Live microbet (minutes)"), h("option", { value: "future" }, "Future (days)")),
    h("label", { for: "question" }, "Question (yes/no)"),
    h("input", { id: "question", name: "question", required: true, minlength: 5, maxlength: 200 }),
    h("label", { for: "amount" }, "Closes in (minutes for micro, days for future)"),
    h("input", { id: "amount", name: "amount", type: "number", min: 1, value: gameConfig.markets.defaultMicroMinutes, required: true }),
    h("label", { for: "source" }, "Resolution source"),
    h("input", { id: "source", name: "source", maxlength: 200, value: "Resolved by the operator." }),
    h("button", { class: "primary", type: "submit" }, "Open market"),
  );
}

function render(): void {
  if (!secret()) return replace(root, login());
  if (!state) return replace(root, h("p", {}, "Loading…"));
  const s = state;
  const share = s.rowsWrittenToday / s.rowsBudget;
  const live = s.markets.filter((m) => m.state === "open" || m.state === "closed");
  const done = s.markets.filter((m) => m.state === "resolved" || m.state === "void");
  replace(
    root,
    h(
      "div",
      { class: "admin" },
      h("h1", {}, `${gameConfig.appName} · operator`),
      h("p", { class: "msg", role: "status" }, msg),
      h(
        "div",
        { class: "admin-stats" },
        h("p", {}, `Players: ${pts(s.players)}`),
        h("p", {}, `House take: ${pts(s.houseTake)} · house net: ${pts(s.houseNet)}`),
        h(
          "p",
          { class: share >= s.rowsWarnAt ? "warn" : "" },
          `${share >= s.rowsWarnAt ? "⚠ " : ""}Database writes today: ${pts(s.rowsWrittenToday)} / ${pts(s.rowsBudget)} (${Math.round(share * 100)}%)`,
        ),
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: s.autopilot,
            onchange: (e: Event) => void act({ action: "autopilot", enabled: (e.target as HTMLInputElement).checked }),
          }),
          " Autopilot markets (unattended booth)",
        ),
      ),
      h("h2", {}, `Live markets (${live.length})`),
      h("ul", { class: "admin-list" }, live.map(marketRow)),
      createForm(),
      h("h2", {}, "Recently settled"),
      h("ul", { class: "admin-list" }, done.map(marketRow)),
      h("h2", {}, "Admin log"),
      h("ul", { class: "admin-log" }, s.log.map((l) => h("li", {}, `${new Date(l.at).toLocaleTimeString()} · ${l.action}${l.targetId ? ` #${l.targetId}` : ""}`))),
      h("h2", {}, "Danger zone"),
      h(
        "button",
        {
          class: "danger",
          onclick: () => {
            const typed = window.prompt("This deletes every player, bet, and market and re-seeds. Type RESET to confirm.");
            if (typed === "RESET") void act({ action: "reset", confirm: "RESET" });
          },
        },
        "Reset everything",
      ),
      h("button", { class: "secondary", onclick: () => (setSecret(null), render()) }, "Lock console"),
    ),
  );
}

const conn = new Connection({ onPublic: () => scheduleRefresh() }, false);
conn.start();
setInterval(() => void refresh(), 60_000);
render();
void refresh();
