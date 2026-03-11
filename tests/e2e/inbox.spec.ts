import { test, expect } from '@playwright/test';
import { InboxPage } from './pages/InboxPage';

/**
 * E2E tests for the Inbox page (/inbox).
 *
 * With an empty database the inbox renders an empty state.
 * Filter toggle tests verify UI state changes.
 */
test.describe('Inbox page', () => {
  test('renders the inbox page container', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await expect(inboxPage.inboxContainer).toBeVisible();
  });

  test('shows page heading "דואר"', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    const text = await heading.textContent();
    expect(text).toContain('דואר');
  });

  test('shows empty state when no conversations exist', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    // With no data in DB the conversation list is absent
    const listVisible = await inboxPage.conversationList.isVisible();
    expect(listVisible).toBe(false);

    // And the conversation item count is 0
    const itemCount = await inboxPage.allConversationItems().count();
    expect(itemCount).toBe(0);
  });

  test('both filter buttons are visible', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await expect(inboxPage.filterAllButton).toBeVisible();
    await expect(inboxPage.filterUnreadButton).toBeVisible();
  });

  test('clicking filter-unread adds filter=unread to the URL', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await inboxPage.clickFilterUnread();

    expect(page.url()).toContain('filter=unread');
  });

  test('clicking filter-all removes the unread filter from the URL', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    // Start with the unread filter already active
    await page.goto('/inbox?filter=unread');
    await page.waitForLoadState('networkidle');

    await inboxPage.clickFilterAll();

    expect(page.url()).not.toContain('filter=unread');
  });

  test('inbox page renders correctly after page reload', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await expect(inboxPage.inboxContainer).toBeVisible();

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(inboxPage.inboxContainer).toBeVisible();
  });

  test('unread filter state persists in URL after reload', async ({ page }) => {
    await page.goto('/inbox?filter=unread');
    await page.waitForLoadState('networkidle');

    // Reload — URL param should be preserved by browser
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The URL should still contain the filter
    expect(page.url()).toContain('filter=unread');
  });
});
