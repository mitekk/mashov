import { test, expect } from '@playwright/test';
import { InboxPage } from './pages/InboxPage';

/**
 * E2E tests for the Inbox page (/inbox).
 *
 * Empty-state checks use route mocking so results are deterministic.
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
    await page.route('**/api/v1/mail/conversations*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [],
          pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
        }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    const listVisible = await inboxPage.conversationList.isVisible();
    expect(listVisible).toBe(false);

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

  test('load more appends conversations instead of replacing list', async ({ page }) => {
    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          unreadConversations: 2,
          recentConversations: [],
          lastSyncAt: null,
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      const url = new URL(route.request().url());
      const pageParam = Number(url.searchParams.get('page') ?? '1');
      const body = pageParam === 1
        ? {
          data: [
            {
              conversationId: 'conv-page-1',
              subject: 'First page',
              senderNamePreview: 'Teacher A',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              hasAttachments: false,
              preventReply: false,
              labels: [],
              isHandled: false,
              lastFetchedAt: new Date().toISOString(),
            },
          ],
          pagination: { page: 1, limit: 20, total: 2, totalPages: 2 },
        }
        : {
          data: [
            {
              conversationId: 'conv-page-2',
              subject: 'Second page',
              senderNamePreview: 'Teacher B',
              sendTime: new Date('2026-03-11T10:00:00Z').toISOString(),
              isUnread: false,
              hasAttachments: false,
              preventReply: false,
              labels: [],
              isHandled: false,
              lastFetchedAt: new Date().toISOString(),
            },
          ],
          pagination: { page: 2, limit: 20, total: 2, totalPages: 2 },
        };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await expect(inboxPage.conversationItem('conv-page-1')).toBeVisible();
    await expect(inboxPage.conversationItem('conv-page-2')).toHaveCount(0);

    await page.getByTestId('load-more-conversations').click();
    await expect(inboxPage.conversationItem('conv-page-1')).toBeVisible();
    await expect(inboxPage.conversationItem('conv-page-2')).toBeVisible();
  });

  test('bulk mark-unread action sends selected conversation ids', async ({ page }) => {
    let markUnreadRequestBody: unknown = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          unreadConversations: 1,
          recentConversations: [],
          lastSyncAt: null,
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              conversationId: 'conv-bulk-1',
              subject: 'Bulk item',
              senderNamePreview: 'Teacher',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              hasAttachments: false,
              preventReply: false,
              labels: [],
              isHandled: false,
              lastFetchedAt: new Date().toISOString(),
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/mark-unread', async (route) => {
      markUnreadRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.toggleConversationSelection('conv-bulk-1');
    await expect(inboxPage.bulkActionsBar).toBeVisible();

    await page.getByTestId('bulk-mark-unread').click();
    await expect.poll(() => markUnreadRequestBody).not.toBeNull();
    expect(markUnreadRequestBody).toEqual({ conversationIds: ['conv-bulk-1'] });
  });

  test('bulk archive action removes conversation from inbox list after refetch', async ({ page }) => {
    let archived = false;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          unreadConversations: 1,
          recentConversations: [],
          lastSyncAt: null,
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      const body = archived
        ? {
          data: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        }
        : {
          data: [
            {
              conversationId: 'conv-archive-1',
              subject: 'Archive item',
              senderNamePreview: 'Teacher',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              hasAttachments: false,
              preventReply: false,
              labels: [],
              isHandled: false,
              lastFetchedAt: new Date().toISOString(),
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.route('**/api/v1/mail/conversations/archive', async (route) => {
      archived = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.toggleConversationSelection('conv-archive-1');
    await page.getByTestId('bulk-archive').click();

    await expect(inboxPage.conversationItem('conv-archive-1')).toHaveCount(0);
  });

  test('conversation detail renders full html body and attachment indicator', async ({ page }) => {
    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          unreadConversations: 1,
          recentConversations: [],
          lastSyncAt: null,
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              conversationId: 'conv-detail-1',
              subject: 'Detail subject',
              senderNamePreview: 'Teacher',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              hasAttachments: true,
              preventReply: false,
              labels: [],
              isHandled: false,
              lastFetchedAt: new Date().toISOString(),
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/conv-detail-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conversationId: 'conv-detail-1',
          subject: 'Detail subject',
          sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
          isUnread: true,
          hasDrafts: false,
          hasAttachments: true,
          preventReply: false,
          labels: [],
          isHandled: false,
          lastFetchedAt: new Date().toISOString(),
          messages: [
            {
              messageId: 'msg-detail-1',
              conversationId: 'conv-detail-1',
              senderId: 'sender-1',
              senderName: 'Teacher',
              subject: 'Detail subject',
              bodyHtmlSanitized: '<p>Full content body</p>',
              bodyTextPreview: 'Full content body',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              recipients: [{ displayOrder: 0, displayName: 'Parent', valueType: 'x', targetType: 'y', isGroup: false }],
              hasAttachments: true,
              preventReply: false,
              sentViaEmail: false,
              sentViaSms: false,
            },
          ],
        }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.clickConversation('conv-detail-1');
    await expect(page).toHaveURL('/inbox/conv-detail-1');
    await expect(page.getByText('Full content body')).toBeVisible();
    await expect(page.getByText('יש קבצים מצורפים')).toBeVisible();
  });
});
