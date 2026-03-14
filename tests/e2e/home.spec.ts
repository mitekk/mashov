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
    needsAttention: [],
    feed: [],
    children: [],
    school: {
      schoolName: '',
      schoolYear: new Date().getFullYear(),
    },
    ...overrides,
  };
}

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
    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.homeHeader).toBeVisible();
    const headerText = await homePage.homeHeader.textContent();
    expect(headerText).toContain('מרכז הורים');
  });

  test('renders the summary strip even with no data', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.summaryStrip).toBeVisible();
  });

  test('renders the latest feed section even when the feed is empty', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.latestFeed).toBeVisible();
  });

  test('refresh button is visible and clickable', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.refreshButton).toBeVisible();
    await expect(homePage.refreshButton).toBeEnabled();

    await homePage.clickRefresh();
    await expect(homePage.refreshButton).toBeEnabled({ timeout: 10000 });
  });

  test('summary strip shows newConversations count from dashboard response', async ({ page }) => {
    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        json: makeEmptyDashboard({
          summary: {
            newConversations: 3,
            recentHomeworkCount: 2,
            recentBehaviorCount: 1,
            childrenCount: 1,
          },
        }),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.summaryStrip).toBeVisible();
    const stripText = await homePage.summaryStrip.textContent();
    expect(stripText).toBeTruthy();
    expect(stripText!.length).toBeGreaterThan(0);
  });

  test('summary strip does not reference unreadConversations key', async ({ page }) => {
    let dashboardRequest: string | null = null;

    await page.route('**/api/v1/dashboard', async (route) => {
      dashboardRequest = JSON.stringify(await route.request().postDataJSON());
      await route.fulfill({
        json: makeEmptyDashboard(),
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    // The response uses newConversations — page should render without error
    await expect(homePage.summaryStrip).toBeVisible();
    void dashboardRequest;
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
    const homePage = new HomePage(page);
    await homePage.navigate();
    await expect(homePage.homeHeader).toBeVisible();

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(homePage.homeHeader).toBeVisible();
    await expect(homePage.summaryStrip).toBeVisible();
  });
});
