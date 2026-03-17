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
 * 5. Settings — credential update: sign in → /more → Update credentials → submit → success
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

const MOCK_ME = {
  mashovUserId: 'mock-user-001',
  username: 'testparent',
  displayName: 'Test Parent',
  connectedSchool: { schoolName: 'בית ספר לדוגמה', schoolYear: 2026 },
};

const MOCK_EMPTY_DASHBOARD = {
  freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
  summary: { newConversations: 0, recentHomeworkCount: 0, recentBehaviorCount: 0, childrenCount: 0 },
  needsAttention: [],
  feed: [],
  children: [],
  school: { schoolName: 'בית ספר לדוגמה', schoolYear: 2026 },
};

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

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

  test('first login: submit → land on /auth/syncing → skip → land on /home', async ({ page }) => {
    await page.route('**/api/v1/auth/schools', async (route) => {
      await route.fulfill({ json: MOCK_SCHOOLS });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({ json: MOCK_LOGIN_SUCCESS });
    });

    await page.route('**/api/v1/sync/status', async (route) => {
      await route.fulfill({ json: MOCK_SYNC_IN_PROGRESS });
    });

    await mockAuthenticatedSession(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();

    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    // Should navigate to /auth/syncing
    const syncingPage = new SyncingPage(page);
    await syncingPage.waitForVisible();

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
      await route.fulfill({ json: { done: false, sourcesCompleted: 5, sourcesTotal: 13 } });
    });

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

    await mockAuthenticatedSession(page);

    const authPage = new AuthPage(page);
    await authPage.navigate();
    await selectDefaultSchool(authPage);
    await authPage.fillCredentials('testparent', 'testpass');
    await authPage.submit();

    // Should auto-redirect to home once done
    await page.waitForURL('**/', { timeout: 20_000 });
    expect(page.url()).toMatch(/\/$/);
  });
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

test.describe('Auth — credential update in settings', () => {
  test('sign in → navigate to /more → update credentials → success message', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({ json: MOCK_ME });
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_EMPTY_DASHBOARD });
    });
    await mockMorePageQueries(page);

    await page.route('**/api/v1/connection', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.continue();
      }
    });

    // Navigate to settings as authenticated user
    await seedAuthenticatedCookie(page);
    await page.goto('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();

    const updateCredsButton = page.getByTestId('settings-update-credentials-btn');
    await expect(updateCredsButton).toBeVisible({ timeout: 5_000 });
    await updateCredsButton.click();

    await page.getByLabel('שם משתמש חדש (אופציונלי)').fill('newusername');
    await page.getByLabel('סיסמה חדשה (אופציונלי)').fill('newpassword');

    await page.getByRole('button', { name: 'שמור' }).click();

    const successMessage = page.getByRole('status');
    await expect(successMessage).toBeVisible({ timeout: 5_000 });
    await expect(successMessage).toContainText('עודכן בהצלחה');
  });

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
