import { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly homeHeader: Locator;
  readonly headerChildSelector: Locator;
  readonly refreshButton: Locator;
  readonly summaryStrip: Locator;
  readonly latestFeed: Locator;

  constructor(page: Page) {
    this.page = page;
    this.homeHeader = page.getByTestId('home-header');
    this.headerChildSelector = page.getByTestId('home-header-child-selector');
    this.refreshButton = page.getByTestId('refresh-button');
    this.summaryStrip = page.getByTestId('summary-strip');
    this.latestFeed = page.getByTestId('latest-feed');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/home');
    await this.page.waitForLoadState('networkidle');
  }

  async clickRefresh(): Promise<void> {
    await this.refreshButton.click();
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
}
