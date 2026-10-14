import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true, // Caddy's local CA for "localhost"
    trace: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    testIgnore: /mobile\.spec\.ts/,
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] },
    },
  },
  { name: "pixel-7", testMatch: /mobile\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["Pixel 7"] } },
  { name: "iphone-14", testMatch: /mobile\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["iPhone 14"], browserName: "chromium" } },
  ],
});
