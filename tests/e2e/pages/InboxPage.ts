import { Page, Locator, expect } from '@playwright/test';

export class InboxPage {
  readonly page: Page;
  readonly inboxContainer: Locator;
  readonly filterAllButton: Locator;
  readonly filterUnreadButton: Locator;
  readonly filterArchivedButton: Locator;
  readonly conversationList: Locator;
  readonly bulkActionsBar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.inboxContainer = page.getByTestId('inbox-page');
    this.filterAllButton = page.getByTestId('filter-all');
    this.filterUnreadButton = page.getByTestId('filter-unread');
    this.filterArchivedButton = page.getByTestId('filter-archived');
    this.conversationList = page.getByTestId('conversation-list');
    this.bulkActionsBar = page.getByTestId('inbox-bulk-actions');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/inbox');
    await expect(this.inboxContainer).toBeVisible();
  }

  conversationItem(conversationId: string): Locator {
    return this.page.getByTestId(`conversation-item-${conversationId}`);
  }

  allConversationItems(): Locator {
    return this.page.locator('[data-testid^="conversation-item-"]');
  }

  async clickFilterAll(): Promise<void> {
    await this.filterAllButton.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'all');
  }

  async clickFilterUnread(): Promise<void> {
    await this.filterUnreadButton.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'new');
  }

  async clickFilterArchived(): Promise<void> {
    await this.filterArchivedButton.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'archived');
  }

  async clickConversation(conversationId: string): Promise<void> {
    await this.conversationItem(conversationId).click();
    await this.page.waitForURL(
      (url) => url.pathname === `/inbox/${conversationId}`,
    );
  }

  async toggleConversationSelection(conversationId: string): Promise<void> {
    await this.page.getByTestId(`conversation-select-${conversationId}`).click();
  }

  /** The chip row. Absent entirely below two connected schools. */
  get schoolFilterChips() {
    return this.page.getByTestId('school-filter-chips');
  }

  schoolFilterChip(semel: number | 'all') {
    return this.page.getByTestId(`school-filter-chip-${semel}`);
  }

  /** Press a school's chip and wait for the URL to carry it. */
  async filterBySchool(semel: number | 'all'): Promise<void> {
    await this.schoolFilterChip(semel).click();
    await this.page.waitForURL(
      semel === 'all' ? (url) => !url.search.includes('school=') : `**?*school=${semel}*`,
    );
  }

  /** A row's school badge; absent below two connected schools. */
  schoolBadge(id: string) {
    return this.page.getByTestId(
      `conversation-school-${id}`,
    );
  }
}
