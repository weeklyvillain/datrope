import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config";

// Unit tests live next to the code in src/; e2e/ is Playwright's.
export default mergeConfig(vite, defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"] } }));
