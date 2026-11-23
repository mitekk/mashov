import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright configuration for the Mashov E2E test suite.
 *
 * Tests run against the full Dockerized stack.
 * Run `docker compose up -d --wait` before executing E2E tests.
 *
 * Frontend: http://localhost:3000 (Next.js)
 * Backend:  http://localhost:3001 (NestJS)
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const authFile = path.join(__dirname, 'tests/e2e/.auth/session.json');

const configuredWorkers = process.env.PLAYWRIGHT_WORKERS;
const parsedConfiguredWorkers = configuredWorkers
  ? Number.parseInt(configuredWorkers, 10)
  : undefined;

if (
  configuredWorkers &&
  (!Number.isInteger(parsedConfiguredWorkers) || parsedConfiguredWorkers <= 0)
) {
  throw new Error(
    `PLAYWRIGHT_WORKERS must be a positive integer. Got: "${configuredWorkers}"`,
  );
}

const workerCount = parsedConfiguredWorkers ?? (process.env.CI ? 2 : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  // Maximum time one test can run
  timeout: 30_000,

  // Fail fast in CI: stop after first failure per worker
  fullyParallel: true,

  // Retry failing tests once in CI
  retries: process.env.CI ? 1 : 0,

  // Default to 2 workers in CI, keep Playwright default locally.
  workers: workerCount,

  // Reporters: 'github' for CI annotations, 'html' for local review
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['html', { outputFolder: 'playwright-report', open: 'on-failure' }]],

  use: {
    // All tests run against the Dockerized frontend
    baseURL,

    // Capture trace on first retry for debugging
    trace: 'on-first-retry',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',

    // Viewport matching common mobile screen (app is mobile-first)
    viewport: { width: 390, height: 844 },
  },

  projects: [
    // --- Setup: write auth storage state once ---
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },

    // --- Auth specs: unauthenticated flows, so NO session cookie ---
    //
    // `auth-recovery.spec.ts` belongs here and not in `chromium` below: every
    // screen it drives (forgot-password, reset-password, mfa) exists precisely
    // for someone who cannot sign in. Run with a pre-set session it would also
    // inherit the `setup` dependency, which needs a working backend to mint
    // one -- for tests that mock every API call.
    {
      name: 'chromium-auth',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/auth.spec.ts', '**/auth-recovery.spec.ts'],
    },

    // --- All other specs: run with session cookie pre-set ---
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
        userAgent: 'mashov-e2e-browser',
        extraHTTPHeaders: {
          'x-mashov-e2e-auth-bypass': '1',
        },
      },
      testIgnore: ['**/auth.spec.ts', '**/auth-recovery.spec.ts'],
      dependencies: ['setup'],
    },
  ],

  // Point at the Dockerized frontend — tests assume `docker compose up -d --wait` was run first
  // Do not start webServer here; CI workflow handles docker compose startup
  webServer: {
    command: 'echo "Expecting Docker stack to be running. Run: docker compose up -d --wait"',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
