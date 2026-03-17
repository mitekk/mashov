/**
 * Playwright setup project: write a storage state file with the `mashov_session`
 * cookie set so all non-auth specs can skip the login flow.
 *
 * Next.js middleware only checks for the cookie's *existence* — it does not
 * validate the token server-side.  All API calls in the non-auth E2E specs
 * are intercepted via `page.route()`, so the backend session guard never runs.
 */
import { test as setup } from '@playwright/test';
import * as path from 'path';

const authFile = path.join(__dirname, '.auth', 'session.json');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

setup('create authenticated session', async ({ page }) => {
  // Navigate to trigger middleware (any URL works — we intercept before it matters)
  await page.goto('/');

  await page.context().addCookies([
    {
      name: 'mashov_session',
      value: 'e2e-bypass-token',
      url: baseURL,
      httpOnly: false,
      secure: false,
    },
  ]);

  await page.context().storageState({ path: authFile });
});
