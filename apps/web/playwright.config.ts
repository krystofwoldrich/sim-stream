import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun run --cwd ../cli src/index.ts start",
      port: 3100,
      timeout: 15000,
      reuseExistingServer: true,
    },
    {
      command: "bunx vite",
      port: 5173,
      timeout: 15000,
      reuseExistingServer: true,
    },
  ],
});
