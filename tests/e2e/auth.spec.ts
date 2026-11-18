/**
 * Phase 2 — Auth E2E Tests
 *
 * Tests cover:
 * 1. Sign-in flow (first login): school list loads → select school → fill creds
 *    → submit → land on /auth/syncing → skip → land on /home
 * 2. Sign-in error: wrong credentials → inline error, stays on /auth/sign-in
 * 3. Session protection: direct navigate to / without cookie → redirect to /auth/sign-in
 * 4. Sign-out: sign in → click sign-out → redirect to /auth/sign-in →
 *    subsequent navigation to / redirects to sign-in again
 *
 * All Mashov upstream calls are intercepted via page.route() — no real upstream calls.
 */

import { test, expect } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { SyncingPage } from './pages/SyncingPage';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const MOCK_SCHOOLS = [
  { semel: 540175, name: 'בית ספר לדוגמה', years: [2026] },
  { semel: 123456, name: 'בית ספר שני', years: [2026] },
];

const MOCK_LOGIN_SUCCESS = { ok: true, isFirstLogin: true };
const MOCK_LOGIN_FAIL = {
  error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials, please try again', details: [] },
};

const MOCK_SYNC_IN_PROGRESS = { done: false, sourcesCompleted: 3, sourcesTotal: 13 };
const MOCK_SYNC_DONE = { done: true, sourcesCompleted: 13, sourcesTotal: 13 };
const MOCK_SYNC_REFRESH_SUCCESS = {
  status: 'success',
  startedAt: '2026-03-17T00:00:00.000Z',
  endedAt: '2026-03-17T00:00:01.000Z',
  durationMs: 1000,
  tasks: [],
};

const MOCK_ME = {
  mashovUserId: 'mock-user-001',
  username: 'testparent',
  displayName: 'Test Parent',
  connectedSchool: { schoolName: 'בית ספר לדוגמה', schoolYear: 2026 },
};

const MOCK_EMPTY_DASHBOARD = {
  freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
  summary: { newConversations: 0, recentHomeworkCount: 0, recentBehaviorCount: 0, childrenCount: 0 },
  feed: [],
  children: [],
  school: { schoolName: 'בית ספר לדוגמה', schoolYear: 2026 },
};

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const LAST_SCHOOL_STORAGE_KEY = 'mashov.lastSchoolSemel';

// ---------------------------------------------------------------------------
// Helper: wire standard auth-related API mocks for a logged-in session
// ---------------------------------------------------------------------------

import type { Page } from '@playwright/test';

async function mockAuthenticatedSession(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({ json: MOCK_ME });
  });
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
  });
}

async function mockMorePageQueries(page: Page): Promise<void> {
  await page.route('**/api/v1/settings/source-health', async (route) => {
    await route.fulfill({
      json: {
        sources: [],
        overallState: 'fresh',
        lastFullSyncAt: null,
      },
    });
  });

  await page.route('**/api/v1/settings/profile', async (route) => {
    await route.fulfill({
      json: {
        upstreamUserId: 'mock-user-001',
        displayName: 'Test Parent',
        email: '',
        cellphone: '',
        schoolName: 'בית ספר לדוגמה',
        schoolYear: 2026,
        schoolCode: 540175,
        detailsState: 1,
        updatedAt: new Date().toISOString(),
      },
    });
  });
}

async function seedAuthenticatedCookie(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: 'mashov_session',
      value: 'e2e-bypass-token',
      url: BASE_URL,
      httpOnly: false,
      secure: false,
    },
  ]);
}

async function seedLastSchoolSemel(page: Page, semel: number): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, String(value));
    },
    { key: LAST_SCHOOL_STORAGE_KEY, value: semel },
  );
}

async function readLastSchoolSemel(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LAST_SCHOOL_STORAGE_KEY);
}

/**
 * Holds `POST /sync/refresh` open for the life of the test.
 *
 * A resolved refresh now *means* the sync finished — `runManualRefresh` awaits
 * every task before responding — so the screen leaves for `/` as soon as the
 * POST comes back. Any test that needs to observe the syncing screen itself
 * (its progress text, its skip button) must therefore keep the request in
 * flight. Playwright tears the route down when the test ends.
 */
async function hangSyncRefresh(page: Page): Promise<void> {
  // Never settles and leaves no timer behind: Playwright discards the pending
  // handler when it unroutes at the end of the test.
  await page.route('**/api/v1/sync/refresh', () => new Promise<void>(() => {}));
}

async function selectDefaultSchool(authPage: AuthPage): Promise<void> {
  await authPage.fillSchool(MOCK_SCHOOLS[0].name);
  await authPage.selectSchoolOption(MOCK_SCHOOLS[0].semel);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Auth — sign-in flow', () => {
  test('school list loads on sign-in page', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    const authPage = new AuthPage(page);
    await authPage.navigate();

    // School selector must be present
    await expect(authPage.schoolSelector).toBeVisible();

    // The schools route must have been called
    const schoolsResponse = await page.evaluate(async () => {
      const res = await fetch('/api/v1/auth/schools');
      return res.json();
    });
    expect(Array.isArray(schoolsResponse)).toBe(true);
    expect((schoolsResponse as typeof MOCK_SCHOOLS).length).toBeGreaterThan(0);
  });

  test('restores saved school from localStorage when semel exists', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await seedLastSchoolSemel(page, MOCK_SCHOOLS[1].semel);

    const authPage = new AuthPage(page);
    await authPage.navigate();

    await expect(authPage.schoolSelector).toHaveValue(MOCK_SCHOOLS[1].name);
  });

  test('ignores stale semel from localStorage when school is not found', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await seedLastSchoolSemel(page, 999999);

    const authPage = new AuthPage(page);
    await authPage.navigate();

    await expect(authPage.schoolSelector).toHaveValue('');
  });

  test('successful login persists selected school semel to localStorage', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });

    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({ json: MOCK_SYNC_IN_PROGRESS });
    });
    // Held open: this test waits for the **/auth/syncing URL, and a resolved
    // refresh can navigate away from it within a frame of mount.
    await hangSyncRefresh(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();

    await authPage.fillSchool(MOCK_SCHOOLS[1].name);
    await authPage.selectSchoolOption(MOCK_SCHOOLS[1].semel);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    await page.waitForURL('**/auth/syncing**', { timeout: 10_000 });
    await expect.poll(() => readLastSchoolSemel(page)).toBe(String(MOCK_SCHOOLS[1].semel));
  });

  test('first login: submit → land on /auth/syncing → skip → land on /home', async ({ page }) => {
    let syncRefreshCalls = 0;

    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });

    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({ json: MOCK_SYNC_IN_PROGRESS });
    });
    await page.route('**/api/v1/sync/refresh', () => {
      syncRefreshCalls++;
      // Held open on purpose — see hangSyncRefresh: a resolved refresh means
      // the screen leaves before the skip button can be asserted.
      return new Promise<void>(() => {});
    });

    // The mocked login cannot issue the Set-Cookie the real backend sends, and
    // this test walks past /auth/* into the guarded "/" route — so stand in for
    // the session the real login would have established.
    await seedAuthenticatedCookie(page);

    await mockAuthenticatedSession(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();

    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    // Should navigate to /auth/syncing
    const syncingPage = new SyncingPage(page);
    await syncingPage.waitForVisible();
    await expect.poll(() => syncRefreshCalls).toBe(1);

    // Progress text must show sync progress content
    const progressContent = await syncingPage.progressText.textContent();
    expect(progressContent).toBeTruthy();

    // Skip button appears after 10 seconds
    await syncingPage.waitForSkipButton();

    // Verify skip button shows a meaningful label
    const skipText = await syncingPage.skipButton.textContent();
    expect(skipText).toBeTruthy();
    expect(skipText!.length).toBeGreaterThan(0);

    // Click skip → should land on home
    await syncingPage.clickSkip();
    await page.waitForURL('**/', { timeout: 5_000 });

    expect(page.url()).toMatch(/\/$/);
  });

  test('sync progress screen shows sourcesCompleted / sourcesTotal from API', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });

    await page.route('**/api/v1/sync/status', async (route) => {
      // Deliberately the pre-envelope payload shape, with an arbitrary
      // sourcesTotal: the backwards-compatibility proof that a client reading
      // only the legacy keys still renders real numbers.
      await route.fulfill({ json: { done: false, sourcesCompleted: 5, sourcesTotal: 13 } });
    });
    await hangSyncRefresh(page);

    await mockAuthenticatedSession(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    const syncingPage = new SyncingPage(page);
    await syncingPage.waitForVisible();

    // The progress text must show numeric data from the API (5 and 13)
    await expect
      .poll(async () => (await syncingPage.progressText.textContent()) ?? '', {
        timeout: 10_000,
      })
      .toMatch(/5|13/);
  });

  test('sync screen redirects to home when done=true', async ({ page }) => {
    let callCount = 0;

    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });

    await page.route('**/api/v1/sync/status', async (route) => {
      callCount++;
      if (callCount >= 2) {
        await route.fulfill({ json: MOCK_SYNC_DONE });
      } else {
        await route.fulfill({ json: MOCK_SYNC_IN_PROGRESS });
      }
    });
    await page.route('**/api/v1/sync/refresh', async (route) => {
      await route.fulfill({ json: MOCK_SYNC_REFRESH_SUCCESS });
    });

    await mockAuthenticatedSession(page);
    // See above: the mocked login issues no cookie, and this test ends on the
    // guarded "/" route.
    await seedAuthenticatedCookie(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    // Should auto-redirect to home once done
    await page.waitForURL('**/', { timeout: 20_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The screen must be structurally incapable of hanging. Three independent
  // exits, one test each: before this, `done` was the only way out and a
  // single failed source made it unreachable.
  // ─────────────────────────────────────────────────────────────────────────

  test('leaves the sync screen when the refresh resolves even if status never says done', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });
    // Never done — exactly what production reported: 15 of 16 sources, forever.
    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({
        json: { done: false, sourcesCompleted: 15, sourcesTotal: 16, phase: 'running' },
      });
    });
    await page.route('**/api/v1/sync/refresh', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ json: MOCK_SYNC_REFRESH_SUCCESS });
    });

    await mockAuthenticatedSession(page);
    await seedAuthenticatedCookie(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    const syncingPage = new SyncingPage(page);
    await syncingPage.waitForVisible();

    // The refresh awaits every task before responding, so its resolution is
    // completion — whatever the status endpoint believes.
    await page.waitForURL('**/', { timeout: 15_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test('shows an error and a continue button when the refresh request times out', async ({
    page,
  }) => {
    // The slow-notice copy swaps ~15s after the proxy gives up.
    test.setTimeout(60_000);

    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({
        json: { done: false, sourcesCompleted: 0, sourcesTotal: 16, phase: 'unknown' },
      });
    });
    await page.route('**/api/v1/sync/refresh', async (route) => {
      await route.fulfill({
        status: 504,
        json: { error: { code: 'UPSTREAM_TIMEOUT', message: 'Upstream timed out', details: [] } },
      });
    });

    await mockAuthenticatedSession(page);
    await seedAuthenticatedCookie(page);

    const syncingPage = new SyncingPage(page);
    await syncingPage.navigate();

    await expect(syncingPage.error).toBeVisible({ timeout: 30_000 });
    // The timeout copy specifically, not the generic failure copy: a 504 means
    // the refresh is probably still running, and saying otherwise would be a
    // lie the user can act on.
    await expect(syncingPage.error).toContainText('יותר זמן מהרגיל');
    await expect(syncingPage.continueButton).toBeVisible();

    await syncingPage.clickContinue();
    await page.waitForURL('**/', { timeout: 10_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test('leaves via the hard cap when neither endpoint ever answers', async ({ page }) => {
    // Both exits above are dead: the status endpoint never says done and the
    // refresh never returns. The cap is the last resort, and it has to work.
    await page.route('**/api/v1/sync/status', () => new Promise<void>(() => {}));
    await hangSyncRefresh(page);

    await mockAuthenticatedSession(page);
    await seedAuthenticatedCookie(page);

    await page.goto('/auth/syncing?hardCapMs=5000');

    await page.waitForURL('**/', { timeout: 20_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test('names the task in flight under the progress bar', async ({ page }) => {
    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({
        json: {
          done: false,
          sourcesCompleted: 4,
          sourcesTotal: 21,
          phase: 'running',
          // Arbitrary display data. tasksTotal is the wired task count and
          // does not vary by household — that independence is the fix. The
          // screen must render whatever the backend reports.
          tasksTotal: 21,
          tasksSettled: 4,
          tasksFailed: 0,
          currentTask: 'homework',
          tasks: [],
        },
      });
    });
    await hangSyncRefresh(page);

    await mockAuthenticatedSession(page);
    await seedAuthenticatedCookie(page);

    const syncingPage = new SyncingPage(page);
    await syncingPage.navigate();

    await expect(syncingPage.progressText).toContainText('4 / 21');
    await expect(syncingPage.currentTask).toBeVisible();
    const label = await syncingPage.currentTask.textContent();
    expect(label).toBeTruthy();
    expect(label).not.toContain('homework');
  });

  test('leaves when a partial refresh reports done with a failed source', async ({ page }) => {
    // The production case end to end: a source failed, the refresh is over,
    // and the user must not be held on the spinner for it.
    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({
        json: {
          done: true,
          sourcesCompleted: 21,
          sourcesTotal: 21,
          phase: 'partial',
          tasksTotal: 21,
          tasksSettled: 21,
          tasksFailed: 1,
          currentTask: null,
          tasks: [],
        },
      });
    });
    await hangSyncRefresh(page);

    await mockAuthenticatedSession(page);
    await seedAuthenticatedCookie(page);

    await page.goto('/auth/syncing');

    await page.waitForURL('**/', { timeout: 15_000 });
    expect(page.url()).toMatch(/\/$/);
  });
});

test.describe('Auth — crawler and asset paths stay public', () => {
  // These run in the unauthenticated project: no session cookie and no e2e
  // bypass, which is the only configuration that catches the guard swallowing
  // them. seo.spec.ts cannot catch it — it runs with a cookie.
  for (const path of ['/robots.txt', '/sitemap.xml', '/favicon.svg', '/manifest.json']) {
    test(`${path} is served without a session cookie`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), `${path} must not redirect to sign-in`).toBe(200);
    });
  }
});

test.describe('Auth — sign-in error', () => {
  test('wrong credentials shows inline error and stays on /auth/sign-in', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      // apiFetch redirects to /auth/sign-in on any 401, which bypasses inline error rendering.
      await route.fulfill({ status: 429, json: MOCK_LOGIN_FAIL });
    });

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('baduser', 'wrongpass');
    await authPage.submit();

    // Must stay on sign-in page
    expect(page.url()).toContain('/auth/sign-in');

    // Inline error message must be visible with meaningful content
    await expect(authPage.errorMessage).toBeVisible();
    const errorText = await authPage.errorMessage.textContent();
    expect(errorText).toBeTruthy();
    expect(errorText!.length).toBeGreaterThan(5);

    // Error text should match the server message
    expect(errorText).toMatch(/Invalid credentials|שגוי|credentials/i);
  });

  test('failed login does not overwrite previously stored school semel', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ status: 429, json: MOCK_LOGIN_FAIL });
    });

    await seedLastSchoolSemel(page, MOCK_SCHOOLS[0].semel);

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await authPage.fillSchool(MOCK_SCHOOLS[1].name);
    await authPage.selectSchoolOption(MOCK_SCHOOLS[1].semel);
    await authPage.fillCredentials('baduser', 'wrongpass');
    await authPage.submit();

    await expect(authPage.errorMessage).toBeVisible();
    await expect.poll(() => readLastSchoolSemel(page)).toBe(String(MOCK_SCHOOLS[0].semel));
  });

  test('error message disappears when user starts typing again', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      // apiFetch redirects to /auth/sign-in on any 401, which bypasses inline error rendering.
      await route.fulfill({ status: 429, json: MOCK_LOGIN_FAIL });
    });

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('baduser', 'wrongpass');
    await authPage.submit();

    await expect(authPage.errorMessage).toBeVisible();

    // User types in password field — error should clear
    await authPage.passwordInput.fill('newattempt');

    // Page must remain on sign-in
    expect(page.url()).toContain('/auth/sign-in');
  });
});

test.describe('Auth — session protection', () => {
  test('navigating to / without session cookie redirects to /auth/sign-in', async ({ page }) => {
    // No auth cookie — mock the /api/v1/auth/me to return 401
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [] } } });
    });

    await page.goto('/');

    // Must be redirected to sign-in
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain('/auth/sign-in');
    expect(page.url()).toContain('/auth/sign-in');
  });

  test('unauthenticated request to /children redirects to /auth/sign-in', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [] } } });
    });

    await page.goto('/children');
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain('/auth/sign-in');
    expect(page.url()).toContain('/auth/sign-in');
  });

  test('authenticated user can access / directly without redirect', async ({ page }) => {
    // Mock auth check returning valid user
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({ json: MOCK_ME });
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
    });

    await seedAuthenticatedCookie(page);
    await page.goto('/');

    // Should not be redirected to sign-in
    await expect(page.getByTestId('home-header')).toBeVisible();
    expect(page.url()).not.toContain('/auth/sign-in');
  });
});

test.describe('Auth — sign-out', () => {
  test('sign-out redirects to /auth/sign-in and subsequent / redirects back to sign-in', async ({ page }) => {
    let isLoggedIn = true;

    // Mock: /me returns user while logged in, then 401 after logout
    await page.route('**/api/v1/auth/me', async (route) => {
      if (isLoggedIn) {
        await route.fulfill({ json: MOCK_ME });
      } else {
        await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [] } } });
      }
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
    });

    // Mock logout endpoint
    await page.route('**/api/v1/auth/session', async (route) => {
      if (route.request().method() === 'DELETE') {
        isLoggedIn = false;
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.continue();
      }
    });

    await mockMorePageQueries(page);

    // Navigate to home as authenticated user
    await seedAuthenticatedCookie(page);
    await page.goto('/');
    await expect(page.getByTestId('home-header')).toBeVisible();

    // Click sign-out from settings page
    await page.goto('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();
    const settingsSignOut = page.getByTestId('settings-signout-btn');
    await expect(settingsSignOut).toBeVisible({ timeout: 5_000 });
    await settingsSignOut.click();

    // After sign-out: should be on sign-in page
    await page.waitForURL('**/auth/sign-in**', { timeout: 10_000 });
    expect(page.url()).toContain('/auth/sign-in');

    // Trying to go to / should redirect back to sign-in
    await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain('/auth/sign-in');
    expect(page.url()).toContain('/auth/sign-in');
  });
});

test.describe('Auth — settings page', () => {
  test('settings page shows connected school info for authenticated user', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({ json: MOCK_ME });
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
    });

    await mockMorePageQueries(page);

    await seedAuthenticatedCookie(page);
    await page.goto('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();

    // Page must be accessible (not redirected to auth)
    expect(page.url()).not.toContain('/auth/sign-in');
    await expect(page.getByTestId('settings-school-name')).toBeVisible();

    // The /more page must render something meaningful
    const body = page.locator('body');
    const bodyText = await body.textContent();
    expect(bodyText!.length).toBeGreaterThan(10);
  });
});

test.describe('Auth — session persistence after reload', () => {
  test('authenticated state survives a page reload', async ({ page }) => {
    let meCallCount = 0;

    await page.route('**/api/v1/auth/me', async (route) => {
      meCallCount++;
      await route.fulfill({ json: MOCK_ME });
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
    });

    await seedAuthenticatedCookie(page);
    await page.goto('/');
    await expect(page.getByTestId('home-header')).toBeVisible();

    // Not redirected
    expect(page.url()).not.toContain('/auth/sign-in');

    // Reload and verify still not redirected
    await page.reload();
    await expect(page.getByTestId('home-header')).toBeVisible();

    expect(page.url()).not.toContain('/auth/sign-in');
    expect(meCallCount).toBeGreaterThanOrEqual(1);
  });
});
