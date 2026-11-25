import { Page, Locator, expect } from '@playwright/test';

export class ChildrenPage {
  readonly page: Page;
  readonly childrenPageContainer: Locator;
  /** The `sr-only` h1 -- the document outline, not anything a user sees. */
  readonly pageHeading: Locator;
  /** The visible title, which lives in the app header. */
  readonly headerTitle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.childrenPageContainer = page.getByTestId('children-page');
    this.pageHeading = page.getByRole('heading', { name: 'ילדים' });
    this.headerTitle = page.getByTestId('app-header-title');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/children');
    // Gate on the visible title: `pageHeading` is `sr-only`, and a 1x1 box
    // passes `toBeVisible`, so it would not catch a title that stopped
    // rendering.
    await expect(this.headerTitle).toBeVisible();
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
