// One command for local development and the offline booth fallback:
// starts the game server (local Durable Object + SQLite), the front end,
// and fake players. Phones on the same Wi-Fi can join via the LAN address.
//
//   npm run dev            server + front end + fake players
//   npm run dev -- --no-bots
//   npm run dev -- --bots 12

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const noBots = args.includes("--no-bots");
const botCount = Number(args[args.indexOf("--bots") + 1]) || 6;

// --- local secrets (gitignored) ---
if (!existsSync(".dev.vars")) {
  writeFileSync(
    ".dev.vars",
    `# Local development only. Never commit this file.\nADMIN_SECRET=${randomBytes(24).toString("hex")}\nALLOWED_ORIGINS=*\n`,
  );
  console.log("Created .dev.vars with a fresh local ADMIN_SECRET.");
}
const adminSecret = /ADMIN_SECRET=(\S+)/.exec(readFileSync(".dev.vars", "utf8"))?.[1] ?? "(see .dev.vars)";

const lan =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
    ?.address ?? "localhost";

const children = [];
function run(name, cmd, cmdArgs, color) {
  const child = spawn(cmd, cmdArgs, { shell: process.platform === "win32", env: process.env });
  children.push(child);
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) out.write(tag + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (code && !stopping) {
      console.error(`${tag}exited with code ${code}; shutting down.`);
      stop(code);
    }
  });
  return child;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("server", "npx", ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1", "--log-level", "warn"], "35");
run("web", "npx", ["vite", "--clearScreen", "false", "--logLevel", "warn"], "36");

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8787/api/health");
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (await waitForServer()) {
  const base = `http://${lan}:5173`;
  console.log(`
\x1b[33m==================== CAMERA READY (local) ====================\x1b[0m
  Phone (scan or type):  ${base}/
  Shared board:          ${base}/board/
  Operator console:      ${base}/admin/
  Admin secret:          ${adminSecret}   (from .dev.vars)
  Fake players:          ${noBots ? "off" : botCount}
  Open the board via the address above (not "localhost") so its QR code works for phones.
  Ctrl+C stops everything.
\x1b[33m==============================================================\x1b[0m
`);
  if (!noBots) run("bots", "node", ["sim/fake-players.ts", "--count", String(botCount)], "32");
} else {
  console.error("Game server did not start within 60 s.");
  stop(1);
}
