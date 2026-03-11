import { Page, Locator } from '@playwright/test';

export class ChildrenPage {
  readonly page: Page;
  readonly childrenPageContainer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.childrenPageContainer = page.getByTestId('children-page');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/children');
    await this.page.waitForLoadState('networkidle');
  }

  childCard(studentGuid: string): Locator {
    return this.page.getByTestId(`child-list-card-${studentGuid}`);
  }

  allChildCards(): Locator {
    return this.page.locator('[data-testid^="child-list-card-"]');
  }

  async clickChild(studentGuid: string): Promise<void> {
    await this.childCard(studentGuid).click();
    await this.page.waitForLoadState('networkidle');
  }
}
