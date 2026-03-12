import { Page, Locator } from '@playwright/test';

export class InboxPage {
  readonly page: Page;
  readonly inboxContainer: Locator;
  readonly filterAllButton: Locator;
  readonly filterUnreadButton: Locator;
  readonly conversationList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.inboxContainer = page.getByTestId('inbox-page');
    this.filterAllButton = page.getByTestId('filter-all');
    this.filterUnreadButton = page.getByTestId('filter-unread');
    this.conversationList = page.getByTestId('conversation-list');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/inbox');
    await this.page.waitForLoadState('networkidle');
  }

  conversationItem(conversationId: string): Locator {
    return this.page.getByTestId(`conversation-item-${conversationId}`);
  }

  allConversationItems(): Locator {
    return this.page.locator('[data-testid^="conversation-item-"]');
  }

  async clickFilterAll(): Promise<void> {
    await this.filterAllButton.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') !== 'unread');
  }

  async clickFilterUnread(): Promise<void> {
    await this.filterUnreadButton.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'unread');
  }

  async clickConversation(conversationId: string): Promise<void> {
    await this.conversationItem(conversationId).click();
    await this.page.waitForLoadState('networkidle');
  }
}
