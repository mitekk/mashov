import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Mashov E2E test suite.
 *
 * Tests run against the full Dockerized stack.
 * Run `docker compose up -d --wait` before executing E2E tests.
 *
 * Frontend: http://localhost:3000 (Next.js)
 * Backend:  http://localhost:3001 (NestJS)
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  // Maximum time one test can run
  timeout: 30_000,

  // Fail fast in CI: stop after first failure per worker
  fullyParallel: true,

  // Retry failing tests once in CI
  retries: process.env.CI ? 1 : 0,

  // One worker in CI to avoid race conditions on shared DB
  workers: process.env.CI ? 1 : undefined,

  // Reporters: 'github' for CI annotations, 'html' for local review
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['html', { outputFolder: 'playwright-report', open: 'on-failure' }]],

  use: {
    // All tests run against the Dockerized frontend
    baseURL: 'http://localhost:3000',

    // Capture trace on first retry for debugging
    trace: 'on-first-retry',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',

    // Viewport matching common mobile screen (app is mobile-first)
    viewport: { width: 390, height: 844 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Point at the Dockerized frontend — tests assume `docker compose up -d --wait` was run first
  // Do not start webServer here; CI workflow handles docker compose startup
  webServer: {
    command: 'echo "Expecting Docker stack to be running. Run: docker compose up -d --wait"',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
