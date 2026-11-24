import { test, expect, type Page, type Route } from '@playwright/test';
import { FeedbackPage } from './pages/FeedbackPage';

/**
 * The parent feedback channel, end to end in a real browser.
 *
 * What only this layer can show: that the icon is actually reachable from an
 * ordinary authenticated screen, that the native subject picker and the
 * conditional label field work in a real engine, and that the thank-you
 * appears over the bottom nav and can be dismissed. The component test proves
 * the form's rules; this proves the parent can get to it.
 *
 * `POST /feedback` is mocked. A real post would need a real household, and the
 * row it writes is exactly what the integration test already asserts about.
 */

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

interface Seed {
  /** Non-201 answers from the feedback route, e.g. the per-user 429. */
  failure?: { status: number; body: unknown };
}

interface Calls {
  bodies: Record<string, unknown>[];
}

async function seed(page: Page, options: Seed = {}): Promise<Calls> {
  const calls: Calls = { bodies: [] };

  // Registered FIRST so every specific route below wins. An endpoint this spec
  // does not anticipate would otherwise reach the real backend, answer 401,
  // and apiFetch's global handler would send the browser to /auth/sign-in --
  // which looks exactly like a feedback button that refused to open.
  await page.route('**/api/v1/**', (route) =>
    json(route, { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
  );

  await page.route('**/api/v1/auth/me', (route) =>
    json(route, {
      mashovUserId: 'fb-parent-1',
      username: 'fb-parent',
      displayName: 'הורה',
      childrenCount: 1,
      schools: [
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'תיכון הרצוג',
          shortLabel: 'הרצוג',
          schoolYear: 2026,
        },
      ],
    }),
  );

  // The app shell reads `freshness.state`; the catch-all's list envelope has
  // none, which is an undefined read rather than an empty screen.
  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        unreadConversations: 0,
        recentHomeworkCount: 0,
        recentBehaviorCount: 0,
        childrenCount: 1,
      },
      feed: [],
      children: [],
    }),
  );

  // The dialog prefills the reply address from here.
  await page.route('**/api/v1/settings/profile', (route) =>
    json(route, [
      {
        householdConnectionId: 'conn-1',
        upstreamUserId: 'fb-parent-1',
        displayName: 'הורה',
        email: 'parent@example.com',
        cellphone: '',
        schoolName: 'תיכון הרצוג',
        schoolYear: 2026,
        schoolCode: 540175,
        detailsState: 1,
        updatedAt: new Date().toISOString(),
      },
    ]),
  );

  await page.route('**/api/v1/feedback', async (route) => {
    calls.bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (options.failure) {
      return json(route, options.failure.body, options.failure.status);
    }
    return json(
      route,
      {
        data: {
          id: 'fb-row-1',
          subject: 'other',
          createdAt: new Date().toISOString(),
        },
      },
      201,
    );
  });

  return calls;
}

test.describe('parent feedback', () => {
  test('sends a report with a custom subject from the home screen', async ({ page }) => {
    const calls = await seed(page);
    const feedback = new FeedbackPage(page);

    await page.goto('/home');
    await feedback.open();

    // The reply address arrives already filled in from the Mashov profile.
    await expect(feedback.emailInput).toHaveValue('parent@example.com');

    // No label field until the parent asks for one.
    await expect(feedback.subjectOtherInput).toHaveCount(0);
    await feedback.pickSubject('other');
    await expect(feedback.subjectOtherInput).toBeVisible();
    await feedback.subjectOtherInput.fill('הדף נטען לאט');

    await feedback.fillContent('לוקח המון זמן לטעון את מערכת השעות');
    await expect(feedback.contentCounter).toContainText('34');

    await feedback.submit();

    await expect(feedback.thanks).toBeVisible();
    await expect(feedback.dialog).toHaveCount(0);

    expect(calls.bodies).toHaveLength(1);
    expect(calls.bodies[0]).toMatchObject({
      subject: 'other',
      subjectOther: 'הדף נטען לאט',
      content: 'לוקח המון זמן לטעון את מערכת השעות',
      contactEmail: 'parent@example.com',
      // Captured for us, not typed by the parent.
      pagePath: '/home',
    });
    expect(typeof calls.bodies[0].viewportWidth).toBe('number');

    await feedback.dismissThanks();
    await expect(feedback.thanks).toHaveCount(0);
  });

  test('reaches the form from the settings screen too', async ({ page }) => {
    await seed(page);
    const feedback = new FeedbackPage(page);

    await page.goto('/more');
    await feedback.open();

    await expect(feedback.subjectSelect).toBeVisible();
    await feedback.cancelButton.click();
    await expect(feedback.dialog).toHaveCount(0);
  });

  /** The per-user hourly limit, as the parent experiences it. */
  test('tells the parent to come back later when the hourly limit is hit', async ({ page }) => {
    await seed(page, {
      failure: {
        status: 429,
        body: {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many feedback reports. Try again later.',
            details: [],
          },
        },
      },
    });
    const feedback = new FeedbackPage(page);

    await page.goto('/home');
    await feedback.open();
    await feedback.fillContent('עוד דיווח');
    await feedback.submit();

    await expect(feedback.error).toBeVisible();
    await expect(feedback.error).toContainText('נסו שוב מאוחר יותר');
    // The form stays open with the text still in it, so nothing is lost.
    await expect(feedback.dialog).toBeVisible();
    await expect(feedback.contentTextarea).toHaveValue('עוד דיווח');
    await expect(feedback.thanks).toHaveCount(0);
  });
});
