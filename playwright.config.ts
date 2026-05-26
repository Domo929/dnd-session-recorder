import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the local smoke test.
 *
 * The smoke test assumes the app is already running at SMOKE_BASE_URL
 * (default http://localhost:3000). `scripts/smoke.sh` is responsible for
 * bringing up Docker Compose and waiting for /api/health before invoking
 * Playwright.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
