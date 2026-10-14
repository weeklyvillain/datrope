import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// In development the Go server runs on :8080 (override with DATROPE_DEV_SERVER,
// e.g. "localhost:8081"); the browser only talks to Vite, so cookies and the
// WebSocket stay same-origin as in production.
const server = process.env.DATROPE_DEV_SERVER ?? "localhost:8080";
// LiveKit (voice) runs on :7880 in development (override with DATROPE_DEV_LIVEKIT).
const livekit = process.env.DATROPE_DEV_LIVEKIT ?? "localhost:7880";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false, // src/sw-register.ts registers it, and not inside the desktop app
      manifest: false, // the server serves /manifest.webmanifest, named after the instance
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2,mp3,ogg,wasm}"], maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 },
      devOptions: { enabled: false },
    }),
  ],
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
      "/manifest.webmanifest": `http://${server}`,
      "/ws": { target: `ws://${server}`, ws: true },
      // Production has Caddy strip the same prefix (deploy/Caddyfile).
      "/livekit": { target: `http://${livekit}`, ws: true, rewrite: (p) => p.replace(/^\/livekit/, "") },
    },
  },
});
