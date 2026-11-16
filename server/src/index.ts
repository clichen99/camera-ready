// Worker entry: origin checks, CORS, security headers, admin authentication.
// Everything stateful is forwarded to the single GameDO instance.

import { safeEqual } from "./engine/crypto";
import type { Env } from "./game-do";

export { GameDO } from "./game-do";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function originAllowed(origin: string | null, env: Env): boolean {
  const list = allowedOrigins(env);
  if (list.includes("*")) return true; // local development only (.dev.vars)
  return origin !== null && list.includes(origin);
}

function withHeaders(res: Response, origin: string | null, env: Env): Response {
  if (res.status === 101) return res; // WebSocket upgrade responses must pass through untouched
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (origin && originAllowed(origin, env)) {
    out.headers.set("access-control-allow-origin", origin);
    out.headers.set("vary", "Origin");
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403 });
      return withHeaders(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": "600",
          },
        }),
        origin,
        env,
      );
    }

    if (url.pathname === "/api/health") return withHeaders(new Response("ok"), origin, env);

    // Browsers always send Origin on cross-origin fetches and WebSocket upgrades.
    // Requests from origins we did not list are refused outright.
    if (!originAllowed(origin, env)) return withHeaders(new Response("forbidden origin", { status: 403 }), origin, env);

    const stub = env.GAME.get(env.GAME.idFromName("main"));

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return withHeaders(new Response("expected websocket", { status: 426 }), origin, env);
      }
      // The object's /ws handler reads no headers, so the original request is safe to pass.
      return stub.fetch(request);
    }

    if (!url.pathname.startsWith("/api/")) return withHeaders(new Response("not found", { status: 404 }), origin, env);

    // Build a fresh request so no client-supplied header reaches the object
    // except the two we explicitly forward.
    const headers = new Headers({ "content-type": "application/json" });
    const auth = request.headers.get("authorization");

    if (url.pathname.startsWith("/api/admin/")) {
      const secret = env.ADMIN_SECRET ?? "";
      if (secret.length < 32) return withHeaders(new Response("admin disabled: set ADMIN_SECRET", { status: 503 }), origin, env);
      if (!auth || !safeEqual(auth, `Bearer ${secret}`)) {
        return withHeaders(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }), origin, env);
      }
      headers.set("x-camera-ready-admin", "verified");
    } else if (auth) {
      headers.set("authorization", auth);
    }

    const forwarded = new Request(new URL(url.pathname, url.origin), {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.text() : undefined,
    });
    return withHeaders(await stub.fetch(forwarded), origin, env);
  },
} satisfies ExportedHandler<Env>;
