import { Page, Locator, expect } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly homeHeader: Locator;
  readonly headerChildSelector: Locator;
  readonly refreshButton: Locator;
  readonly latestFeed: Locator;
  readonly feedFilterAllButton: Locator;
  readonly feedFilterArchivedButton: Locator;
  readonly feedFilterUnreadButton: Locator;
  readonly feedBulkActions: Locator;
  readonly feedBulkSelectAllVisibleButton: Locator;
  readonly feedBulkMarkReadButton: Locator;
  readonly feedBulkMarkUnreadButton: Locator;
  readonly feedBulkArchiveButton: Locator;
  readonly feedBulkUnarchiveButton: Locator;
  readonly feedBulkClearSelectionButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.homeHeader = page.getByTestId('home-header');
    this.headerChildSelector = page.getByTestId('home-header-child-selector');
    this.refreshButton = page.getByTestId('refresh-button');
    this.latestFeed = page.getByTestId('latest-feed');
    this.feedFilterAllButton = page.getByTestId('home-feed-filter-all');
    this.feedFilterArchivedButton = page.getByTestId('home-feed-filter-archived');
    this.feedFilterUnreadButton = page.getByTestId('home-feed-filter-unread');
    this.feedBulkActions = page.getByTestId('feed-bulk-actions');
    this.feedBulkSelectAllVisibleButton = page.getByTestId('feed-bulk-select-all-visible');
    this.feedBulkMarkReadButton = page.getByTestId('feed-bulk-mark-read');
    this.feedBulkMarkUnreadButton = page.getByTestId('feed-bulk-mark-unread');
    this.feedBulkArchiveButton = page.getByTestId('feed-bulk-archive');
    this.feedBulkUnarchiveButton = page.getByTestId('feed-bulk-unarchive');
    this.feedBulkClearSelectionButton = page.getByTestId('feed-bulk-clear-selection');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/home');
    await expect(this.homeHeader).toBeVisible({ timeout: 15_000 });
  }

  async clickRefresh(): Promise<void> {
    await this.refreshButton.click();
  }

  async clickFeedFilterAll(): Promise<void> {
    await this.feedFilterAllButton.click();
  }

  async clickFeedFilterArchived(): Promise<void> {
    await this.feedFilterArchivedButton.click();
  }

  async clickFeedFilterUnread(): Promise<void> {
    await this.feedFilterUnreadButton.click();
  }

  feedItem(id: string): Locator {
    return this.page.getByTestId(`feed-item-${id}`);
  }

  markNewButton(itemId: string): Locator {
    return this.page.getByTestId(`feed-item-mark-new-${itemId}`);
  }

  archiveButton(itemId: string): Locator {
    return this.page.getByTestId(`feed-item-archive-${itemId}`);
  }

  feedSelectCheckbox(itemId: string): Locator {
    return this.page.getByTestId(`feed-select-${itemId}`);
  }
}
