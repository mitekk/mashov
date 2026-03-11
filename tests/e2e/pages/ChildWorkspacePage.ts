import { Page, Locator } from '@playwright/test';

export class ChildWorkspacePage {
  readonly page: Page;
  readonly workspaceContainer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.workspaceContainer = page.getByTestId('child-workspace');
  }

  async navigate(studentGuid: string): Promise<void> {
    await this.page.goto(`/children/${studentGuid}`);
    await this.page.waitForLoadState('networkidle');
  }

  sectionTab(sectionId: 'homework' | 'behavior' | 'subjects' | 'notices'): Locator {
    return this.page.getByTestId(`section-tab-${sectionId}`);
  }

  async clickSection(sectionId: 'homework' | 'behavior' | 'subjects' | 'notices'): Promise<void> {
    await this.sectionTab(sectionId).click();
    // Brief wait for section content to render
    await this.page.waitForTimeout(300);
  }
}
