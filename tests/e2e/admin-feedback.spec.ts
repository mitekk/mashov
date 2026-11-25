import { test, expect, type Page, type Route } from '@playwright/test';
import { AdminFeedbackPage, AdminFeedbackDetailPage } from './pages/AdminFeedbackPage';

/**
 * The operator triage surface, end to end in a real browser.
 *
 * What only this layer can show: that `/admin/feedback` is reachable WITHOUT a
 * parent session -- the middleware edit this change makes -- that the screen
 * renders standalone with no AppShell, that each filter is a server-side
 * refetch driven by the URL, and that opening a row clears its "new" state.
 *
 * The admin API is mocked. The stack runs with ADMIN_AUTH_MODE=insecure-dev
 * (plus ENABLE_E2E_AUTH_BYPASS=1, which the mode requires), so an unmocked
 * call would succeed against an empty table rather than 403 -- but the lens
 * sets are what the integration test owns, and mocking is what lets this file
 * assert about a FIXED three-row matrix.
 */

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const BASE = {
  subject: 'bug',
  subjectOther: null,
  displayName: 'קורס דמיטרי',
  username: 'parent-one',
  schools: ['הרצוג (540175)'],
  notifiedAt: '2026-11-28T10:02:00.000Z',
  respondedAt: null,
};

const UNREAD = {
  ...BASE,
  id: 'row-unread',
  hasContactEmail: true,
  createdAt: '2026-11-28T10:00:00.000Z',
  readAt: null,
};

const READ = {
  ...BASE,
  id: 'row-read',
  hasContactEmail: true,
  createdAt: '2026-11-28T09:00:00.000Z',
  readAt: '2026-11-28T09:30:00.000Z',
};

const UNDELIVERED = {
  ...BASE,
  id: 'row-undelivered',
  hasContactEmail: false,
  createdAt: '2026-11-28T08:00:00.000Z',
  readAt: '2026-11-28T08:30:00.000Z',
  respondedAt: '2026-11-28T08:40:00.000Z',
  notifiedAt: null,
};

const LENSES: Record<string, (typeof UNREAD)[]> = {
  all: [UNREAD, READ, UNDELIVERED],
  new: [UNREAD],
  awaiting: [UNREAD, READ],
};

function detailFor(id: string) {
  const item = [UNREAD, READ, UNDELIVERED].find((row) => row.id === id) ?? UNREAD;
  return {
    ...item,
    // Opening the detail is what stamps readAt server-side, so the mocked
    // response reflects that -- as the real API would.
    readAt: item.readAt ?? '2026-11-28T11:00:00.000Z',
    contactEmail: item.hasContactEmail ? 'parent@example.com' : null,
    content: `דיווח מלא עבור ${id}`,
    pagePath: '/children/abc',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 390,
    viewportHeight: 844,
    appVersion: '1.4.2',
    mashovUserId: 'mashov-1',
    notifyAttempts: item.notifiedAt ? 1 : 3,
    notifyError: item.notifiedAt ? null : 'Telegram send failed: Bad Request: chat not found',
  };
}

interface Calls {
  listFilters: string[];
  detailIds: string[];
  responded: string[];
}

async function seed(page: Page): Promise<Calls> {
  const calls: Calls = { listFilters: [], detailIds: [], responded: [] };

  // Registered FIRST so every specific route below wins. An endpoint this spec
  // does not anticipate would otherwise reach the real backend, answer 401,
  // and apiFetch's global handler would send the browser to /auth/sign-in --
  // which looks exactly like an admin page that refused to load.
  await page.route('**/api/v1/**', (route) =>
    json(route, { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
  );

  await page.route('**/api/v1/admin/feedback/*/response', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').slice(-2)[0];
    calls.responded.push(id);
    return json(route, {
      data: { ...detailFor(id), respondedAt: '2026-11-28T12:00:00.000Z' },
    });
  });

  await page.route('**/api/v1/admin/feedback/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    calls.detailIds.push(id);
    return json(route, { data: detailFor(id) });
  });

  await page.route('**/api/v1/admin/feedback?*', (route) => {
    const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'all';
    calls.listFilters.push(filter);
    const data = LENSES[filter] ?? [];
    return json(route, {
      data,
      pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length > 0 ? 1 : 0 },
    });
  });

  return calls;
}

test.describe('admin feedback triage', () => {
  test('renders without a parent session and lists every report', async ({ page }) => {
    // No sign-in, no mashov_session cookie. `/admin` is in the middleware's
    // PUBLIC_PATHS precisely so an operator is not bounced to the parent
    // sign-in page; the backend guard is the real gate.
    await seed(page);
    const triage = new AdminFeedbackPage(page);
    await triage.goto();

    await expect(page).toHaveURL(/\/admin\/feedback$/);
    await expect(triage.allRows()).toHaveCount(3);
    await expect(triage.row(UNREAD.id)).toContainText('תקלה');
    await expect(triage.row(UNREAD.id)).toContainText('הרצוג (540175)');
  });

  test('is standalone — no parent navigation on the page', async ({ page }) => {
    await seed(page);
    await new AdminFeedbackPage(page).goto();

    await expect(page.getByTestId('bottom-nav')).toHaveCount(0);
    await expect(page.locator('[data-testid="admin-feedback-page"][dir="ltr"]')).toBeVisible();
  });

  test('shows the state each row is actually in', async ({ page }) => {
    await seed(page);
    const triage = new AdminFeedbackPage(page);
    await triage.goto();

    await expect(triage.newChip(UNREAD.id)).toBeVisible();
    await expect(triage.awaitingChip(UNREAD.id)).toBeVisible();
    // Read, so not new; answered, so not awaiting.
    await expect(triage.newChip(READ.id)).toHaveCount(0);
    await expect(triage.awaitingChip(READ.id)).toBeVisible();
    // A report the outbox gave up on is visible here rather than only in a log.
    await expect(triage.undeliveredChip(UNDELIVERED.id)).toBeVisible();
    await expect(triage.undeliveredChip(UNREAD.id)).toHaveCount(0);
  });

  test('each filter is a server-side refetch, driven by the URL', async ({ page }) => {
    const calls = await seed(page);
    const triage = new AdminFeedbackPage(page);
    await triage.goto();

    await triage.clickFilterNew();
    await expect(triage.allRows()).toHaveCount(1);
    await expect(triage.row(UNREAD.id)).toBeVisible();

    await triage.clickFilterAwaiting();
    await expect(triage.allRows()).toHaveCount(2);
    await expect(triage.row(UNDELIVERED.id)).toHaveCount(0);

    await triage.clickFilterAll();
    await expect(triage.allRows()).toHaveCount(3);

    // The filter is in the query key, so each lens asked the SERVER rather
    // than re-filtering a page already in hand. Returning to `all` adds no
    // fourth call: that lens is still inside its staleTime, which is the
    // caching the key buys and not a client-side filter.
    expect(calls.listFilters).toEqual(['all', 'new', 'awaiting']);
  });

  test('a filter in the URL survives a reload', async ({ page }) => {
    await seed(page);
    await page.goto('/admin/feedback?filter=new');
    const triage = new AdminFeedbackPage(page);
    await expect(triage.container).toBeVisible();

    await expect(triage.allRows()).toHaveCount(1);
    await expect(triage.filterNew).toHaveAttribute('aria-current', 'true');
  });

  test('an empty lens offers a way out of it', async ({ page }) => {
    await seed(page);
    // Override the awaiting lens to empty, after the catch-alls in seed().
    await page.route('**/api/v1/admin/feedback?*', (route) => {
      const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'all';
      const data = filter === 'awaiting' ? [] : LENSES[filter];
      return json(route, {
        data,
        pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length > 0 ? 1 : 0 },
      });
    });

    const triage = new AdminFeedbackPage(page);
    await triage.goto();
    await triage.clickFilterAwaiting();

    await expect(page.getByText('Nothing awaiting a response')).toBeVisible();
    await triage.filterReset.click();
    await expect(triage.allRows()).toHaveCount(3);
  });

  test('opening a row shows the whole report and clears its new state', async ({ page }) => {
    const calls = await seed(page);
    const triage = new AdminFeedbackPage(page);
    await triage.goto();

    const detail = await triage.openRow(UNREAD.id);

    await expect(detail.content).toHaveText(`דיווח מלא עבור ${UNREAD.id}`);
    await expect(detail.contactEmail).toHaveText('parent@example.com');
    await expect(detail.delivery).toContainText('Delivered');
    expect(calls.detailIds).toContain(UNREAD.id);
  });

  test('a failed delivery is visible on the screen that replaced it', async ({ page }) => {
    await seed(page);
    const detail = new AdminFeedbackDetailPage(page);
    await detail.goto(UNDELIVERED.id);

    await expect(detail.delivery).toContainText('Not delivered after 3 attempt(s)');
    await expect(detail.notifyError).toContainText('chat not found');
  });

  test('marking a report answered records it and offers no second click', async ({ page }) => {
    const calls = await seed(page);
    const detail = new AdminFeedbackDetailPage(page);
    await detail.goto(UNREAD.id);

    await expect(detail.markResponded).toBeVisible();
    await detail.markResponded.click();

    await expect(detail.respondedAt).toContainText('Answered');
    await expect(detail.markResponded).toHaveCount(0);
    expect(calls.responded).toEqual([UNREAD.id]);
  });

  test('a report that does not exist says so rather than hanging', async ({ page }) => {
    await seed(page);
    await page.route('**/api/v1/admin/feedback/*', (route) =>
      json(route, { error: { code: 'NOT_FOUND', message: 'Feedback report not found', details: [] } }, 404),
    );

    const detail = new AdminFeedbackDetailPage(page);
    await detail.goto('row-missing');

    await expect(page.getByText('That report does not exist.')).toBeVisible();
  });

  test('back returns to the triage list', async ({ page }) => {
    await seed(page);
    const detail = new AdminFeedbackDetailPage(page);
    await detail.goto(UNREAD.id);

    await detail.back.click();

    await expect(new AdminFeedbackPage(page).container).toBeVisible();
  });
});
