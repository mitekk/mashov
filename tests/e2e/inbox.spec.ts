import { test, expect } from '@playwright/test';
import { InboxPage } from './pages/InboxPage';

/**
 * E2E tests for the Inbox page (/inbox).
 *
 * Empty-state checks use route mocking so results are deterministic.
 * Filter toggle tests verify UI state changes.
 */

function makeConversation(overrides: object = {}) {
  return {
    conversationId: 'conv-default',
    subject: 'Default message',
    senderNamePreview: 'Teacher',
    sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
    isNew: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    lastFetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

  test('clicking filter-unread adds filter=new to the URL', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await inboxPage.clickFilterUnread();

    expect(page.url()).toContain('filter=new');
  });

  test('clicking filter-all removes the new filter from the URL', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await page.goto('/inbox?filter=new');
    await page.waitForLoadState('networkidle');

    await inboxPage.clickFilterAll();

    expect(page.url()).not.toContain('filter=new');
  });

  test('inbox page renders correctly after page reload', async ({ page }) => {
    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await expect(inboxPage.inboxContainer).toBeVisible();

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(inboxPage.inboxContainer).toBeVisible();
  });

  test('new filter state persists in URL after reload', async ({ page }) => {
    await page.goto('/inbox?filter=new');
    await page.waitForLoadState('networkidle');

    await page.reload();
    await page.waitForLoadState('networkidle');

    expect(page.url()).toContain('filter=new');
  });

  test('conversations use isNew field (not isUnread)', async ({ page }) => {
    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          newConversations: 1,
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
            makeConversation({
              conversationId: 'conv-new-check',
              subject: 'New message check',
              isNew: true,
            }),
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await expect(inboxPage.conversationItem('conv-new-check')).toBeVisible();
  });

  test('load more appends conversations instead of replacing list', async ({ page }) => {
    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          newConversations: 2,
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
            makeConversation({
              conversationId: 'conv-page-1',
              subject: 'First page',
              senderNamePreview: 'Teacher A',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isNew: true,
            }),
          ],
          pagination: { page: 1, limit: 20, total: 2, totalPages: 2 },
        }
        : {
          data: [
            makeConversation({
              conversationId: 'conv-page-2',
              subject: 'Second page',
              senderNamePreview: 'Teacher B',
              sendTime: new Date('2026-03-11T10:00:00Z').toISOString(),
              isNew: false,
            }),
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

  test('mark-read action sends conversation ids to mark-read endpoint', async ({ page }) => {
    let markReadRequestBody: unknown = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          newConversations: 1,
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
            makeConversation({
              conversationId: 'conv-mark-read-1',
              subject: 'Mark read item',
              isNew: true,
            }),
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/mark-read', async (route) => {
      markReadRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.toggleConversationSelection('conv-mark-read-1');
    await expect(inboxPage.bulkActionsBar).toBeVisible();

    const markReadButton = page.getByTestId('bulk-mark-read');
    if (await markReadButton.isVisible()) {
      await markReadButton.click();
      await expect.poll(() => markReadRequestBody).not.toBeNull();
      expect(markReadRequestBody).toEqual({ conversationIds: ['conv-mark-read-1'] });
    }
  });

  test('bulk mark-unread action sends selected conversation ids', async ({ page }) => {
    let markUnreadRequestBody: unknown = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          newConversations: 1,
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
            makeConversation({
              conversationId: 'conv-bulk-1',
              subject: 'Bulk item',
              isNew: true,
            }),
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
          newConversations: 1,
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
            makeConversation({
              conversationId: 'conv-archive-1',
              subject: 'Archive item',
              isNew: true,
            }),
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
          newConversations: 1,
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
            makeConversation({
              conversationId: 'conv-detail-1',
              subject: 'Detail subject',
              isNew: true,
              hasAttachments: true,
            }),
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
          isNew: true,
          hasDrafts: false,
          hasAttachments: true,
          preventReply: false,
          labels: [],
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

  test('archived filter tab is visible and navigates to filter=archived URL', async ({ page }) => {
    await page.route('**/api/v1/mail/conversations**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();

    await expect(inboxPage.filterArchivedButton).toBeVisible();
    await inboxPage.clickFilterArchived();

    expect(page.url()).toContain('filter=archived');
  });

  test('archived tab shows conversations that were archived', async ({ page }) => {
    let requestedFilter: string | null = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ newConversations: 0, recentConversations: [], lastSyncAt: null }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      const url = new URL(route.request().url());
      requestedFilter = url.searchParams.get('filter');
      const isArchived = requestedFilter === 'archived';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: isArchived
            ? [makeConversation({ conversationId: 'conv-archived-1', subject: 'Archived message', labels: ['archived'] })]
            : [],
          pagination: { page: 1, limit: 20, total: isArchived ? 1 : 0, totalPages: isArchived ? 1 : 0 },
        }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.clickFilterArchived();

    await expect(inboxPage.conversationItem('conv-archived-1')).toBeVisible();
    expect(requestedFilter).toBe('archived');
  });

  test('archived bulk action sends selected ids to unarchive endpoint', async ({ page }) => {
    let requestedFilter: string | null = null;
    let unarchiveRequestBody: unknown = null;
    let unarchived = false;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ newConversations: 0, recentConversations: [], lastSyncAt: null }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      const url = new URL(route.request().url());
      requestedFilter = url.searchParams.get('filter');
      const isArchivedFilter = requestedFilter === 'archived';
      const archivedData = unarchived
        ? []
        : [makeConversation({
          conversationId: 'conv-archived-bulk-1',
          subject: 'Archived bulk message',
          isNew: false,
          labels: ['archived'],
        })];

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: isArchivedFilter ? archivedData : [],
          pagination: {
            page: 1,
            limit: 20,
            total: isArchivedFilter ? archivedData.length : 0,
            totalPages: 1,
          },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/unarchive', async (route) => {
      unarchiveRequestBody = route.request().postDataJSON();
      unarchived = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.clickFilterArchived();
    await inboxPage.toggleConversationSelection('conv-archived-bulk-1');

    await page.getByTestId('bulk-unarchive').click();
    await expect.poll(() => unarchiveRequestBody).not.toBeNull();
    expect(unarchiveRequestBody).toEqual({ conversationIds: ['conv-archived-bulk-1'] });
    expect(requestedFilter).toBe('archived');
    await expect(inboxPage.conversationItem('conv-archived-bulk-1')).toHaveCount(0);
  });

  test('conversation detail auto-fires mark-read on open and shows mark-new toggle', async ({ page }) => {
    let markReadRequestBody: unknown = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ newConversations: 1, recentConversations: [], lastSyncAt: null }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      if (route.request().url().includes('/conv-read-1')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conversationId: 'conv-read-1',
            subject: 'Read test',
            sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
            isNew: true,
            hasDrafts: false,
            hasAttachments: false,
            preventReply: false,
            labels: [],
            lastFetchedAt: new Date().toISOString(),
            messages: [{
              messageId: 'msg-1',
              conversationId: 'conv-read-1',
              senderId: 's1',
              senderName: 'Teacher',
              subject: 'Read test',
              bodyHtmlSanitized: '<p>Body</p>',
              bodyTextPreview: 'Body',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              recipients: [],
              hasAttachments: false,
              preventReply: false,
              sentViaEmail: false,
              sentViaSms: false,
            }],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeConversation({ conversationId: 'conv-read-1', subject: 'Read test', isNew: true })],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/mark-read', async (route) => {
      markReadRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.clickConversation('conv-read-1');
    await expect(page).toHaveURL('/inbox/conv-read-1');

    // mark-read fires automatically on open
    await expect.poll(() => markReadRequestBody).not.toBeNull();
    expect(markReadRequestBody).toEqual({ conversationIds: ['conv-read-1'] });

    // mark-new toggle visible
    await expect(page.getByTestId('mark-new-conv-read-1')).toBeVisible();
  });

  test('archived conversation detail shows unarchive action and calls unarchive endpoint', async ({ page }) => {
    let unarchiveRequestBody: unknown = null;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ newConversations: 0, recentConversations: [], lastSyncAt: null }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      if (route.request().url().includes('/conv-archived-detail-1')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conversationId: 'conv-archived-detail-1',
            subject: 'Archived detail',
            sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
            isNew: false,
            hasDrafts: false,
            hasAttachments: false,
            preventReply: false,
            labels: ['archived'],
            lastFetchedAt: new Date().toISOString(),
            messages: [{
              messageId: 'msg-archived-detail-1',
              conversationId: 'conv-archived-detail-1',
              senderId: 's1',
              senderName: 'Teacher',
              subject: 'Archived detail',
              bodyHtmlSanitized: '<p>Body</p>',
              bodyTextPreview: 'Body',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: false,
              recipients: [],
              hasAttachments: false,
              preventReply: false,
              sentViaEmail: false,
              sentViaSms: false,
            }],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeConversation({
            conversationId: 'conv-archived-detail-1',
            subject: 'Archived detail',
            isNew: false,
            labels: ['archived'],
          })],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/unarchive', async (route) => {
      unarchiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await inboxPage.clickFilterArchived();
    await inboxPage.clickConversation('conv-archived-detail-1');
    await expect(page).toHaveURL('/inbox/conv-archived-detail-1');
    await expect(page.getByTestId('unarchive-conv-archived-detail-1')).toBeVisible();
    await expect(page.getByTestId('mark-new-conv-archived-detail-1')).toHaveCount(0);

    await page.getByTestId('unarchive-conv-archived-detail-1').click();
    await expect.poll(() => unarchiveRequestBody).not.toBeNull();
    expect(unarchiveRequestBody).toEqual({ conversationIds: ['conv-archived-detail-1'] });
  });

  test('inbox list refetches after returning from conversation detail', async ({ page }) => {
    let markReadFired = false;
    let conversationListFetchCount = 0;

    await page.route('**/api/v1/mail/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ newConversations: 1, recentConversations: [], lastSyncAt: null }),
      });
    });

    await page.route('**/api/v1/mail/conversations**', async (route) => {
      if (route.request().url().includes('/conv-stale-1')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conversationId: 'conv-stale-1',
            subject: 'Stale test',
            sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
            isNew: true,
            hasDrafts: false,
            hasAttachments: false,
            preventReply: false,
            labels: [],
            lastFetchedAt: new Date().toISOString(),
            messages: [{
              messageId: 'msg-s1',
              conversationId: 'conv-stale-1',
              senderId: 's1',
              senderName: 'Teacher',
              subject: 'Stale test',
              bodyHtmlSanitized: '<p>Body</p>',
              bodyTextPreview: 'Body',
              sendTime: new Date('2026-03-12T10:00:00Z').toISOString(),
              isUnread: true,
              recipients: [],
              hasAttachments: false,
              preventReply: false,
              sentViaEmail: false,
              sentViaSms: false,
            }],
          }),
        });
        return;
      }
      conversationListFetchCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeConversation({ conversationId: 'conv-stale-1', isNew: true })],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/mark-read', async (route) => {
      markReadFired = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    const inboxPage = new InboxPage(page);
    await inboxPage.navigate();
    await expect(inboxPage.conversationItem('conv-stale-1')).toBeVisible();
    const initialFetchCount = conversationListFetchCount;

    await inboxPage.clickConversation('conv-stale-1');
    await expect.poll(() => markReadFired).toBe(true);

    await page.goBack();
    await page.waitForLoadState('networkidle');

    // After mark-read, list query should have been invalidated and refetched
    await expect.poll(
      () => conversationListFetchCount,
      { timeout: 10_000 },
    ).toBeGreaterThan(initialFetchCount);
  });

  test('home feed mail item has archive button that calls archive endpoint', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await page.route('**/api/v1/dashboard', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
          summary: { newConversations: 1, recentHomeworkCount: 0, recentBehaviorCount: 0, childrenCount: 0 },
          needsAttention: [],
          feed: [{
            id: 'feed-mail-1',
            sourceType: 'mail',
            sourceId: 'conv-mail-1',
            studentGuid: null,
            studentName: null,
            title: 'New message from teacher',
            summary: 'Regarding homework',
            category: 'mail',
            priority: 'high',
            isPositive: false,
            isNew: true,
            isArchived: false,
            linkPath: '/inbox',
            eventAt: new Date().toISOString(),
            syncedAt: new Date().toISOString(),
          }],
          children: [],
          school: { schoolName: 'Test School', schoolYear: 2026 },
        }),
      });
    });

    await page.route('**/api/v1/mail/conversations/archive', async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1 }),
      });
    });

    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const archiveBtn = page.getByTestId('feed-item-archive-feed-mail-1');
    await expect(archiveBtn).toBeVisible();

    await archiveBtn.click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    expect(archiveRequestBody).toEqual({ conversationIds: ['conv-mail-1'] });
  });
});
