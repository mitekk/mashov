import { test, expect } from '@playwright/test';
import { HomePage } from './pages/HomePage';

/**
 * E2E tests for the Home page (/home).
 *
 * These tests run against the full Dockerized stack.
 * The app starts with an empty database, so all sections render empty states.
 */
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
        json: {
          freshness: {
            state: 'fresh',
            lastSyncAt: null,
            staleSources: [],
          },
          summary: {
            unreadConversations: 0,
            recentHomeworkCount: 1,
            recentBehaviorCount: 0,
            childrenCount: 1,
          },
          needsAttention: [],
          feed: [
            {
              id: 'feed-missing-link',
              sourceType: 'homework',
              sourceId: 'hw-1',
              studentGuid: 'student-guid-1',
              studentName: 'Test Student',
              title: 'Homework update',
              summary: 'New assignment',
              category: 'homework',
              priority: 'medium',
              isPositive: false,
              isUnread: true,
              isHandled: false,
              eventAt: new Date().toISOString(),
              syncedAt: new Date().toISOString(),
            },
          ],
          children: [],
          school: {
            schoolName: 'Test School',
            schoolYear: 2026,
          },
        },
      });
    });

    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.homeHeader).toBeVisible();
    await expect(homePage.feedItem('feed-missing-link')).toBeVisible();

    const fallbackLink = homePage.feedItem('feed-missing-link').locator('a');
    await expect(
      fallbackLink,
    ).toHaveAttribute('href', '/children/student-guid-1?section=homework&behavior=all');
    expect(hrefPropErrors).toHaveLength(0);
  });

  test('renders the header and date when the dashboard loads', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    // The home header with the app title must be visible
    await expect(homePage.homeHeader).toBeVisible();
    const headerText = await homePage.homeHeader.textContent();
    expect(headerText).toContain('מרכז הורים');
  });

  test('renders the summary strip even with no data', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    // Summary strip is always rendered once data loads
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

    // Click triggers a sync refresh (fire-and-forget), button re-enables after
    await homePage.clickRefresh();
    // The button should re-enable once the request completes
    await expect(homePage.refreshButton).toBeEnabled({ timeout: 10000 });
  });

  test('summary strip shows numeric counts (zero or above)', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();

    await expect(homePage.summaryStrip).toBeVisible();
    // The strip renders count numbers — verify the element has text content
    const stripText = await homePage.summaryStrip.textContent();
    expect(stripText).toBeTruthy();
    expect(stripText!.length).toBeGreaterThan(0);
  });

  test('page is accessible after a reload', async ({ page }) => {
    const homePage = new HomePage(page);
    await homePage.navigate();
    await expect(homePage.homeHeader).toBeVisible();

    // Reload the page and verify it still works
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(homePage.homeHeader).toBeVisible();
    await expect(homePage.summaryStrip).toBeVisible();
  });
});
