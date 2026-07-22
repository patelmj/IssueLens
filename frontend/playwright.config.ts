import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3005",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3005",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
