import { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly homeHeader: Locator;
  readonly refreshButton: Locator;
  readonly summaryStrip: Locator;
  readonly latestFeed: Locator;
  readonly childrenSection: Locator;

  constructor(page: Page) {
    this.page = page;
    this.homeHeader = page.getByTestId('home-header');
    this.refreshButton = page.getByTestId('refresh-button');
    this.summaryStrip = page.getByTestId('summary-strip');
    this.latestFeed = page.getByTestId('latest-feed');
    this.childrenSection = page.getByTestId('children-section');
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

  markHandledButton(itemId: string): Locator {
    return this.page.getByTestId(`mark-handled-${itemId}`);
  }
}
