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

  // No `viewport` here, deliberately. It used to declare 390x844 with a
  // comment about the app being mobile-first, while every project spread
  // `devices['Desktop Chrome']` -- and project `use` beats top-level `use`, so
  // the suite had only ever run at 1280x720. Deleting the key rather than
  // fixing it means the trap cannot re-form: each project below states its own
  // viewport explicitly, AFTER its device spread.
  use: {
    // All tests run against the Dockerized frontend
    baseURL,

    // Capture trace on first retry for debugging
    trace: 'on-first-retry',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',
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
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
      testMatch: ['**/auth.spec.ts', '**/auth-recovery.spec.ts'],
    },

    // --- All other specs: run with session cookie pre-set ---
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        storageState: authFile,
        userAgent: 'mashov-e2e-browser',
        extraHTTPHeaders: {
          'x-mashov-e2e-auth-bypass': '1',
        },
      },
      // auth and auth-recovery have their own unauthenticated project above;
      // responsive.spec.ts has its own three projects below, and running it
      // here too would duplicate the 1280 pass.
      testIgnore: ['**/auth.spec.ts', '**/auth-recovery.spec.ts', '**/responsive.spec.ts'],
      dependencies: ['setup'],
    },

    // --- The adaptive-layout suite, at the three sizes it is about ---
    //
    // Only responsive.spec.ts. The other specs encode the desktop DOM: at 360
    // they would fail on every lg-only element and triple CI time for no
    // signal, so adaptive coverage lives in one spec across three projects.
    //
    // `isMobile: true` on the phone project is not cosmetic -- it turns on
    // meta-viewport emulation and touch, which is what actually exercises the
    // `maximumScale` removal, `env(safe-area-inset-*)` and svh/dvh behaviour.
    {
      name: 'mobile-360',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 780 },
        isMobile: true,
        hasTouch: true,
        storageState: authFile,
        userAgent: 'mashov-e2e-browser',
        extraHTTPHeaders: {
          'x-mashov-e2e-auth-bypass': '1',
        },
      },
      testMatch: '**/responsive.spec.ts',
      dependencies: ['setup'],
    },
    {
      name: 'tablet-768',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        storageState: authFile,
        userAgent: 'mashov-e2e-browser',
        extraHTTPHeaders: {
          'x-mashov-e2e-auth-bypass': '1',
        },
      },
      testMatch: '**/responsive.spec.ts',
      dependencies: ['setup'],
    },
    {
      name: 'desktop-1280',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: authFile,
        userAgent: 'mashov-e2e-browser',
        extraHTTPHeaders: {
          'x-mashov-e2e-auth-bypass': '1',
        },
      },
      testMatch: '**/responsive.spec.ts',
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
