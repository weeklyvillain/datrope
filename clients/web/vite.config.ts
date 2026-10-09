import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// In development the Go server runs on :8080 (override with DATROPE_DEV_SERVER,
// e.g. "localhost:8081"); the browser only talks to Vite, so cookies and the
// WebSocket stay same-origin as in production.
const server = process.env.DATROPE_DEV_SERVER ?? "localhost:8080";
// LiveKit (voice) runs on :7880 in development (override with DATROPE_DEV_LIVEKIT).
const livekit = process.env.DATROPE_DEV_LIVEKIT ?? "localhost:7880";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@datrope/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://${server}`,
      "/ws": { target: `ws://${server}`, ws: true },
      // Production has Caddy strip the same prefix (deploy/Caddyfile).
      "/livekit": { target: `http://${livekit}`, ws: true, rewrite: (p) => p.replace(/^\/livekit/, "") },
    },
  },
});
