import { Page, Locator } from '@playwright/test';

export class ChildWorkspacePage {
  readonly page: Page;
  readonly workspaceContainer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.workspaceContainer = page.getByTestId('child-workspace');
  }

  async navigate(
    studentGuid: string,
    section: 'homework' | 'behavior' | 'subjects' | 'notices' | 'timetable' = 'homework',
    behavior: 'all' | 'attention' | 'positive' | 'neutral' = 'all',
  ): Promise<void> {
    const params = new URLSearchParams({
      section,
      behavior,
    });
    await this.page.goto(`/children/${studentGuid}?${params.toString()}`);
    await this.page.waitForURL((url) =>
      url.pathname === `/children/${studentGuid}` &&
      url.searchParams.get('section') === section &&
      url.searchParams.get('behavior') === behavior,
    );
  }

  sectionTab(sectionId: 'homework' | 'behavior' | 'subjects' | 'notices' | 'timetable'): Locator {
    return this.page.getByTestId(`section-tab-${sectionId}`);
  }

  async clickSection(sectionId: 'homework' | 'behavior' | 'subjects' | 'notices' | 'timetable'): Promise<void> {
    await this.sectionTab(sectionId).click();
    await this.page.waitForURL((url) => url.searchParams.get('section') === sectionId);
  }
}
