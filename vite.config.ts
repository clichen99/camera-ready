import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";

// Injects a strict Content-Security-Policy into production builds only
// (the dev server needs inline styles for hot reload).
function csp(serverUrl: string): Plugin {
  const connect = ["'self'"];
  if (serverUrl) {
    const u = new URL(serverUrl);
    connect.push(u.origin, `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`);
  }
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
  return {
    name: "camera-ready-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const server = env.VITE_SERVER_URL ?? "";
  return {
    root: "web",
    base: env.VITE_BASE ?? "/",
    envDir: process.cwd(),
    plugins: [csp(server)],
    build: {
      outDir: resolve(__dirname, "dist"),
      emptyOutDir: true,
      // No external resources: everything is bundled.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: resolve(__dirname, "web/index.html"),
          board: resolve(__dirname, "web/board/index.html"),
          admin: resolve(__dirname, "web/admin/index.html"),
        },
      },
    },
    server: {
      host: true, // reachable from phones on the same Wi-Fi
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: "http://127.0.0.1:8787" },
        "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      },
    },
  };
});
