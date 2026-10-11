import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: { alias: { "@": fileURLToPath(new URL("../web/src", import.meta.url)) } },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    rollupOptions: {
      input: {
        rail: fileURLToPath(new URL("./index.html", import.meta.url)),
        offline: fileURLToPath(new URL("./offline.html", import.meta.url)),
        drawer: fileURLToPath(new URL("./drawer.html", import.meta.url)),
      },
    },
  },
});
