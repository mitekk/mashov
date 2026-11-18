import { Page, Locator, expect } from '@playwright/test';

export class ChildrenPage {
  readonly page: Page;
  readonly childrenPageContainer: Locator;
  readonly pageHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.childrenPageContainer = page.getByTestId('children-page');
    this.pageHeading = page.getByRole('heading', { name: 'ילדים' });
  }

  async navigate(): Promise<void> {
    await this.page.goto('/children');
    await expect(this.pageHeading).toBeVisible();
  }

  childCard(studentGuid: string): Locator {
    return this.page.getByTestId(`child-list-card-${studentGuid}`);
  }

  /** The child's class, as shown on their card — the user-visible symptom of a
   *  frozen school year, since it is only ever updated by a roster refresh. */
  childClass(studentGuid: string): Locator {
    return this.page.getByTestId(`child-list-class-${studentGuid}`);
  }

  allChildCards(): Locator {
    return this.page.locator('[data-testid^="child-list-card-"]');
  }

  async clickChild(studentGuid: string): Promise<void> {
    await this.childCard(studentGuid).click();
    await this.page.waitForURL((url) =>
      url.pathname.startsWith(`/children/${studentGuid}`),
    );
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
      `child-list-school-${id}`,
    );
  }
}
