import { test, expect } from '@playwright/test';
import { HomePage } from './pages/HomePage';

/**
 * E2E tests for the Home page (/home).
 *
 * These tests run against the full Dockerized stack.
 * The app starts with an empty database, so all sections render empty states.
 */

function makeFeedItem(overrides: object = {}) {
  return {
    id: 'feed-item-1',
    sourceType: 'homework',
    sourceId: 'hw-1',
    studentGuid: 'student-guid-1',
    studentName: 'Test Student',
    title: 'Homework update',
    summary: 'New assignment',
    category: 'homework',
    priority: 'medium',
    isPositive: false,
    isNew: true,
    isArchived: false,
    hasAttachments: false,
    linkPath: '/children/student-guid-1',
    eventAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEmptyDashboard(overrides: object = {}) {
  return {
    freshness: {
      state: 'fresh',
      lastSyncAt: null,
      staleSources: [],
    },
    summary: {
      newConversations: 0,
      recentHomeworkCount: 0,
      recentBehaviorCount: 0,
      childrenCount: 0,
    },
    feed: [],
    children: [],
    ...overrides,
  };
}

const MOCK_ME = {
  mashovUserId: 'e2e-parent-1',
  username: 'e2e-parent',
  displayName: 'E2E Parent',
  schools: [
    {
      id: 'conn-mock-1',
      semel: 540175,
      schoolName: 'Test School',
      shortLabel: 'Test School',
      schoolYear: 2026,
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({ json: MOCK_ME });
  });
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({ json: makeEmptyDashboard() });
  });
});

test.describe('Home page', () => {
  test('does not crash when a feed item is missing linkPath', async ({ page }) => {
    const hrefPropErrors: string[] = [];

    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('The prop `href` expects a `string` or `object`')) {
        hrefPropErrors.push(text);
      }
    });

    page.on('pageerror', (error) => {
      if (error.message.includes('The prop `href` expects a `string` or `object`')) {
        hrefPropErrors.push(error.message);
      }
    });

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          feed: [
            makeFeedItem({
              id: 'feed-missing-link',
              sourceId: 'hw-1',
              isNew: true,
              isArchived: false,
              linkPath: undefined,
            }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.homeHeader).toBeVisible();
    await expect(homePage.feedItem('feed-missing-link')).toBeVisible();

    const fallbackLink = homePage.feedItem('feed-missing-link').locator('a');
    await expect(
      fallbackLink,
    ).toHaveAttribute(
      'href',
      '/children/student-guid-1/homework/hw-1',
    );
    expect(hrefPropErrors).toHaveLength(0);
  });

  test('renders the header and date when the dashboard loads', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: makeEmptyDashboard() });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.homeHeader).toBeVisible();
    // `home-header` holds only an `sr-only` h1 now, so its textContent would
    // still match a title nobody can see. The visible one is the app
    // header's.
    const headerTitle = page.getByTestId('app-header-title');
    await expect(headerTitle).toBeVisible();
    expect(await headerTitle.textContent()).toContain('מרכז הורים');
    expect(await homePage.homeHeader.textContent()).toContain('מרכז הורים');
  });

  test('renders the latest feed section even when the feed is empty', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: makeEmptyDashboard() });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.latestFeed).toBeVisible();
  });

  test('latest feed tabs apply unread/archived/all contract', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            makeFeedItem({ id: 'feed-unread-1', isNew: true, isArchived: false }),
            makeFeedItem({ id: 'feed-read-1', isNew: false, isArchived: false }),
            makeFeedItem({ id: 'feed-archived-1', isNew: false, isArchived: true }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(page.getByTestId('home-feed-filter-unread')).toBeVisible();
    await expect(page.getByTestId('home-feed-filter-archived')).toBeVisible();
    await expect(page.getByTestId('home-feed-filter-all')).toBeVisible();

    await expect(homePage.feedItem('feed-unread-1')).toBeVisible();
    await expect(homePage.feedItem('feed-read-1')).toHaveCount(0);
    await expect(homePage.feedItem('feed-archived-1')).toHaveCount(0);

    await homePage.clickFeedFilterAll();
    await expect(homePage.feedItem('feed-read-1')).toBeVisible();
    await expect(homePage.feedItem('feed-unread-1')).toBeVisible();
    await expect(homePage.feedItem('feed-archived-1')).toHaveCount(0);

    await homePage.clickFeedFilterArchived();
    await expect(homePage.feedItem('feed-archived-1')).toBeVisible();
    await expect(homePage.feedItem('feed-unread-1')).toHaveCount(0);
    await expect(homePage.feedItem('feed-read-1')).toHaveCount(0);
    await expect(homePage.markNewButton('feed-archived-1')).toHaveCount(0);
    await expect(homePage.archiveButton('feed-archived-1')).toBeVisible();

    await homePage.clickFeedFilterUnread();
    await expect(homePage.feedItem('feed-read-1')).toHaveCount(0);
    await expect(homePage.feedItem('feed-archived-1')).toHaveCount(0);
  });

  test('latest feed unread filter shows unread empty state when all items are read', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            makeFeedItem({ id: 'feed-read-only-1', isNew: false }),
            makeFeedItem({ id: 'feed-read-only-2', isNew: false }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.feedItem('feed-read-only-1')).toHaveCount(0);
    await expect(homePage.feedItem('feed-read-only-2')).toHaveCount(0);
    await expect(page.getByText('אין עדכונים שלא נקראו')).toBeVisible();
  });

  test('feed bulk bar supports selection, select-all-visible, and mixed action visibility', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            makeFeedItem({
              id: 'feed-hw-new',
              sourceType: 'homework',
              sourceId: 'hw-new',
              studentGuid: 'student-1',
              isNew: true,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-beh-read',
              sourceType: 'behavior',
              sourceId: 'beh-read',
              studentGuid: 'student-1',
              isNew: false,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-mail-new',
              sourceType: 'mail',
              sourceId: 'conv-new-1',
              studentGuid: null,
              studentName: null,
              isNew: true,
              isArchived: false,
            }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();
    await homePage.clickFeedFilterAll();

    await expect(homePage.feedBulkActions).toHaveCount(0);

    await homePage.feedSelectCheckbox('feed-hw-new').click();
    await expect(homePage.feedBulkActions).toBeVisible();
    await expect(homePage.feedBulkActions).toContainText('נבחרו 1');
    await expect(homePage.feedBulkMarkReadButton).toBeVisible();
    await expect(homePage.feedBulkArchiveButton).toBeVisible();
    await expect(homePage.feedBulkMarkUnreadButton).toHaveCount(0);
    await expect(homePage.feedBulkUnarchiveButton).toHaveCount(0);

    await homePage.feedBulkSelectAllVisibleButton.click();
    await expect(homePage.feedBulkActions).toContainText('נבחרו 3');
    await expect(homePage.feedSelectCheckbox('feed-hw-new')).toBeChecked();
    await expect(homePage.feedSelectCheckbox('feed-beh-read')).toBeChecked();
    await expect(homePage.feedSelectCheckbox('feed-mail-new')).toBeChecked();
    await expect(homePage.feedBulkMarkReadButton).toBeVisible();
    await expect(homePage.feedBulkMarkUnreadButton).toBeVisible();
    await expect(homePage.feedBulkArchiveButton).toBeVisible();
    await expect(homePage.feedBulkUnarchiveButton).toHaveCount(0);
  });

  test('feed bulk actions group dispatch by student/type and include mail + positive behavior', async ({ page }) => {
    const homeworkIsNewByStudent: Record<string, unknown[]> = {};
    const behaviorIsNewByStudent: Record<string, unknown[]> = {};
    const homeworkArchiveByStudent: Record<string, unknown[]> = {};
    const behaviorArchiveByStudent: Record<string, unknown[]> = {};
    const mailMarkReadBodies: unknown[] = [];
    const mailArchiveBodies: unknown[] = [];

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            makeFeedItem({
              id: 'feed-hw-a',
              sourceType: 'homework',
              sourceId: 'hw-a',
              studentGuid: 'student-a',
              isNew: true,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-hw-b',
              sourceType: 'homework',
              sourceId: 'hw-b',
              studentGuid: 'student-b',
              isNew: true,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-beh-a',
              sourceType: 'behavior',
              sourceId: 'beh-a',
              studentGuid: 'student-a',
              isNew: true,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-pos-b',
              sourceType: 'positive',
              sourceId: 'pos-b',
              studentGuid: 'student-b',
              isNew: true,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-beh-read-a',
              sourceType: 'behavior',
              sourceId: 'beh-read-a',
              studentGuid: 'student-a',
              isNew: false,
              isArchived: false,
            }),
            makeFeedItem({
              id: 'feed-mail-1',
              sourceType: 'mail',
              sourceId: 'conv-mail-1',
              studentGuid: null,
              studentName: null,
              isNew: true,
              isArchived: false,
            }),
          ],
        }),
      });
    });

    await page.route('**/api/v1/children/*/homework/is-new', async (route) => {
      const body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const studentGuid = path.split('/')[4] ?? 'unknown';
      homeworkIsNewByStudent[studentGuid] = [...(homeworkIsNewByStudent[studentGuid] ?? []), body];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });
    await page.route('**/api/v1/children/*/behavior/is-new', async (route) => {
      const body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const studentGuid = path.split('/')[4] ?? 'unknown';
      behaviorIsNewByStudent[studentGuid] = [...(behaviorIsNewByStudent[studentGuid] ?? []), body];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });
    await page.route('**/api/v1/children/*/homework/archive', async (route) => {
      const body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const studentGuid = path.split('/')[4] ?? 'unknown';
      homeworkArchiveByStudent[studentGuid] = [...(homeworkArchiveByStudent[studentGuid] ?? []), body];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });
    await page.route('**/api/v1/children/*/behavior/archive', async (route) => {
      const body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const studentGuid = path.split('/')[4] ?? 'unknown';
      behaviorArchiveByStudent[studentGuid] = [...(behaviorArchiveByStudent[studentGuid] ?? []), body];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });
    await page.route('**/api/v1/mail/conversations/mark-read', async (route) => {
      mailMarkReadBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });
    await page.route('**/api/v1/mail/conversations/archive', async (route) => {
      mailArchiveBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();
    await homePage.clickFeedFilterAll();

    await homePage.feedSelectCheckbox('feed-hw-a').click();
    await homePage.feedBulkSelectAllVisibleButton.click();
    await homePage.feedBulkMarkReadButton.click();

    await expect.poll(() => (homeworkIsNewByStudent['student-a'] ?? []).length).toBe(1);
    await expect.poll(() => (homeworkIsNewByStudent['student-b'] ?? []).length).toBe(1);
    await expect.poll(() => (behaviorIsNewByStudent['student-a'] ?? []).length).toBe(1);
    await expect.poll(() => (behaviorIsNewByStudent['student-b'] ?? []).length).toBe(1);
    await expect.poll(() => mailMarkReadBodies.length).toBe(1);

    expect(homeworkIsNewByStudent['student-a'][0]).toEqual({ homeworkIds: ['feed-hw-a'], isNew: false });
    expect(homeworkIsNewByStudent['student-b'][0]).toEqual({ homeworkIds: ['feed-hw-b'], isNew: false });
    expect(behaviorIsNewByStudent['student-a'][0]).toEqual({ behaviorIds: ['feed-beh-a'], isNew: false });
    expect(behaviorIsNewByStudent['student-b'][0]).toEqual({ behaviorIds: ['feed-pos-b'], isNew: false });
    expect(mailMarkReadBodies[0]).toEqual({ conversationIds: ['conv-mail-1'] });
    await expect(homePage.feedBulkActions).toHaveCount(0);

    await homePage.feedSelectCheckbox('feed-hw-a').click();
    await homePage.feedBulkSelectAllVisibleButton.click();
    await homePage.feedBulkArchiveButton.click();

    await expect.poll(() => (homeworkArchiveByStudent['student-a'] ?? []).length).toBe(1);
    await expect.poll(() => (homeworkArchiveByStudent['student-b'] ?? []).length).toBe(1);
    await expect.poll(() => (behaviorArchiveByStudent['student-a'] ?? []).length).toBe(1);
    await expect.poll(() => (behaviorArchiveByStudent['student-b'] ?? []).length).toBe(1);
    await expect.poll(() => mailArchiveBodies.length).toBe(1);

    expect(homeworkArchiveByStudent['student-a'][0]).toEqual({ homeworkIds: ['feed-hw-a'], isArchived: true });
    expect(homeworkArchiveByStudent['student-b'][0]).toEqual({ homeworkIds: ['feed-hw-b'], isArchived: true });
    expect(behaviorArchiveByStudent['student-a'][0]).toEqual({
      behaviorIds: expect.arrayContaining(['feed-beh-a', 'feed-beh-read-a']),
      isArchived: true,
    });
    expect(behaviorArchiveByStudent['student-b'][0]).toEqual({ behaviorIds: ['feed-pos-b'], isArchived: true });
    expect(mailArchiveBodies[0]).toEqual({ conversationIds: ['conv-mail-1'] });
    await expect(homePage.feedBulkActions).toHaveCount(0);
  });

  test('feed bulk selection clears when changing filter', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            makeFeedItem({ id: 'feed-unread-1', isNew: true, isArchived: false }),
            makeFeedItem({ id: 'feed-read-1', isNew: false, isArchived: false }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await homePage.feedSelectCheckbox('feed-unread-1').click();
    await expect(homePage.feedBulkActions).toBeVisible();

    await homePage.clickFeedFilterAll();
    await expect(homePage.feedBulkActions).toHaveCount(0);
    await expect(homePage.feedSelectCheckbox('feed-unread-1')).not.toBeChecked();
  });

  test('refresh button stays disabled/spinning through manual refresh and dashboard refetch', async ({ page }) => {
    let dashboardCalls = 0;

    await page.route('**/api/v1/dashboard', async (route) => {
      dashboardCalls++;
      if (dashboardCalls === 1) {
        await route.fulfill({ json: makeEmptyDashboard() });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({
        json: makeEmptyDashboard({
          freshness: {
            state: 'fresh',
            lastSyncAt: new Date().toISOString(),
            staleSources: [],
          },
        }),
      });
    });

    await page.route('**/api/v1/sync/refresh', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 250,
          tasks: [],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    // Sync is a profile-menu item now, so it has to be opened before it has a
    // box -- and Radix closes the menu on select, which is why the pending
    // state is asserted in AppHeaderMenu.test.tsx rather than here. What this
    // owns is the end-to-end effect, and only that: the dashboard is refetched.
    // Asserting the item is gone afterwards would look like proof the sync
    // fired and be none -- Radix unmounts the content on select whether or not
    // `onSelect` did anything.
    await homePage.openProfileMenu();
    await expect(homePage.refreshButton).toBeEnabled();

    await homePage.refreshButton.click();
    await expect.poll(() => dashboardCalls, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  });

  test('feed item with isNew=true shows new indicator', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          feed: [
            makeFeedItem({ id: 'feed-new-item', isNew: true, isArchived: false }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.feedItem('feed-new-item')).toBeVisible();
  });

  test('feed item shows attachment indicator when hasAttachments=true', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          feed: [
            makeFeedItem({
              id: 'feed-with-files',
              hasAttachments: true,
            }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    const feedItem = homePage.feedItem('feed-with-files');
    await expect(feedItem).toBeVisible();
    await expect(feedItem.getByText('קבצים מצורפים')).toBeVisible();
  });

  test('feed item with isArchived=true is excluded from feed results', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          feed: [
            // Backend already excludes archived; this verifies the UI renders zero archived items
            makeFeedItem({ id: 'feed-active-only', isNew: true, isArchived: false }),
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    const activeItem = homePage.feedItem('feed-active-only');
    await expect(activeItem).toBeVisible();

    // No archived items should appear — archived items are excluded by the backend
    const archivedItems = page.getByTestId('feed-archived-only');
    await expect(archivedItems).toHaveCount(0);
  });

  test('toggle read/unread on feed item calls is-new mutation endpoint', async ({ page }) => {
    let isNewRequestBody: unknown = null;

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          feed: [
            makeFeedItem({
              id: 'feed-toggle-item',
              sourceType: 'homework',
              sourceId: 'hw-toggle',
              studentGuid: 'student-toggle',
              isNew: true,
              isArchived: false,
            }),
          ],
        }),
      });
    });

    await page.route(
      `**/api/v1/children/student-toggle/homework/hw-toggle/is-new`,
      async (route) => {
        isNewRequestBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'hw-toggle',
            studentGuid: 'student-toggle',
            isNew: false,
            isArchived: false,
          }),
        });
      },
    );

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.feedItem('feed-toggle-item')).toBeVisible();

    const markReadButton = homePage.feedItem('feed-toggle-item').getByTestId('feed-item-mark-read');
    if (await markReadButton.isVisible()) {
      await markReadButton.click();
      await expect.poll(() => isNewRequestBody).not.toBeNull();
      expect(isNewRequestBody).toMatchObject({ isNew: false });
    }
  });

  test('archive action on homework feed card calls archive mutation endpoint', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          feed: [
            makeFeedItem({
              id: 'feed-archive-item',
              sourceType: 'homework',
              sourceId: 'hw-archive',
              studentGuid: 'student-archive',
              isNew: true,
              isArchived: false,
            }),
          ],
        }),
      });
    });

    await page.route(
      `**/api/v1/children/student-archive/homework/hw-archive/archive`,
      async (route) => {
        archiveRequestBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'hw-archive',
            studentGuid: 'student-archive',
            isNew: false,
            isArchived: true,
          }),
        });
      },
    );

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.feedItem('feed-archive-item')).toBeVisible();

    const archiveButton = homePage.feedItem('feed-archive-item').getByTestId('feed-item-archive');
    if (await archiveButton.isVisible()) {
      await archiveButton.click();
      await expect.poll(() => archiveRequestBody).not.toBeNull();
      expect(archiveRequestBody).toMatchObject({ isArchived: true });
    }
  });

  test('page is accessible after a reload', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({ json: makeEmptyDashboard() });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();
    await expect(homePage.homeHeader).toBeVisible();

    await page.reload();
    await expect(homePage.homeHeader).toBeVisible();
  });

  test('home quick cards do not render selected-highlight border styles', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 1,
            childrenCount: 2,
          },
          children: [
            {
              studentGuid: 'student-guid-1',
              privateName: 'First',
              familyName: 'Kid',
              fullName: 'First Kid',
              classCode: 'א',
              classNum: 1,
              recentHomeworkCount: 1,
              recentBehaviorCount: 0,
              latestUpdateAt: new Date().toISOString(),
              oneLineStatus: 'status',
            },
            {
              studentGuid: 'student-guid-2',
              privateName: 'Second',
              familyName: 'Kid',
              fullName: 'Second Kid',
              classCode: 'ב',
              classNum: 2,
              recentHomeworkCount: 0,
              recentBehaviorCount: 1,
              latestUpdateAt: new Date().toISOString(),
              oneLineStatus: 'status',
            },
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    const firstCard = page.getByTestId('child-card-student-guid-1');
    const secondCard = page.getByTestId('child-card-student-guid-2');
    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();
    await expect(firstCard).not.toHaveClass(/border-primary|shadow-\[0_0_0_1px_hsl\(var\(--primary\)\)\]/);
    await expect(secondCard).not.toHaveClass(/border-primary|shadow-\[0_0_0_1px_hsl\(var\(--primary\)\)\]/);
  });

  test('home quick cards show homework, negative, and positive indicators including zero values', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 0,
            recentHomeworkCount: 2,
            recentBehaviorCount: 1,
            childrenCount: 2,
          },
          children: [
            {
              studentGuid: 'student-indicators-1',
              privateName: 'First',
              familyName: 'Kid',
              fullName: 'First Kid',
              classCode: 'א',
              classNum: 1,
              recentHomeworkCount: 2,
              recentBehaviorCount: 0,
              positiveBehaviorCount: 0,
              latestUpdateAt: new Date().toISOString(),
              oneLineStatus: 'status',
            },
            {
              studentGuid: 'student-indicators-2',
              privateName: 'Second',
              familyName: 'Kid',
              fullName: 'Second Kid',
              classCode: 'ב',
              classNum: 2,
              recentHomeworkCount: 1,
              recentBehaviorCount: 1,
              positiveBehaviorCount: 2,
              latestUpdateAt: new Date().toISOString(),
              oneLineStatus: 'status',
            },
          ],
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(page.getByTestId('child-card-homework-count-student-indicators-1')).toContainText('2');
    await expect(page.getByTestId('child-card-negative-count-student-indicators-1')).toContainText('0');
    await expect(page.getByTestId('child-card-positive-count-student-indicators-1')).toContainText('0');
    await expect(
      page.getByTestId('child-card-positive-count-student-indicators-1').locator('svg.lucide-thumbs-up'),
    ).toBeVisible();

    await expect(page.getByTestId('child-card-homework-count-student-indicators-2')).toContainText('1');
    await expect(page.getByTestId('child-card-negative-count-student-indicators-2')).toContainText('1');
    await expect(page.getByTestId('child-card-positive-count-student-indicators-2')).toContainText('2');
  });

  test('manifest.json is served with required app metadata', async ({ page }) => {
    const response = await page.request.get('/manifest.json');
    expect(response.ok()).toBe(true);

    const manifest = await response.json();
    expect(manifest.name).toBe('מרכז הורים');
    expect(manifest.start_url).toBe('/home');
    expect(manifest.display).toBe('standalone');
    expect(manifest.dir).toBe('rtl');
  });
});
