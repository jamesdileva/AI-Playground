import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["**/*.e2e.ts"],
  globalSetup: "tests/e2e/global-setup.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3210",
  },
  webServer: {
    command: "node dist/server.js",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    env: {
      PORT: "3210",
      DB_PATH: "hangout.e2e.db",
    },
  },
});
