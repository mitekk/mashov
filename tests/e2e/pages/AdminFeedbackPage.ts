import { Page, Locator, expect } from '@playwright/test';

/**
 * The operator triage screen. Standalone: no AppShell, no bottom nav, LTR and
 * English, so there is no shared navigation helper to reuse here.
 */
export class AdminFeedbackPage {
  readonly page: Page;
  readonly container: Locator;
  readonly list: Locator;
  readonly filterAll: Locator;
  readonly filterNew: Locator;
  readonly filterAwaiting: Locator;
  readonly filterReset: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('admin-feedback-page');
    this.list = page.getByTestId('admin-feedback-list');
    this.filterAll = page.getByTestId('admin-feedback-filter-all');
    this.filterNew = page.getByTestId('admin-feedback-filter-new');
    this.filterAwaiting = page.getByTestId('admin-feedback-filter-awaiting');
    this.filterReset = page.getByTestId('admin-feedback-filter-reset');
  }

  async goto(): Promise<void> {
    await this.page.goto('/admin/feedback');
    await expect(this.container).toBeVisible();
  }

  row(id: string): Locator {
    return this.page.getByTestId(`admin-feedback-row-${id}`);
  }

  allRows(): Locator {
    return this.page.locator('[data-testid^="admin-feedback-row-"]');
  }

  newChip(id: string): Locator {
    return this.page.getByTestId(`admin-feedback-chip-new-${id}`);
  }

  awaitingChip(id: string): Locator {
    return this.page.getByTestId(`admin-feedback-chip-awaiting-${id}`);
  }

  undeliveredChip(id: string): Locator {
    return this.page.getByTestId(`admin-feedback-chip-undelivered-${id}`);
  }

  async clickFilterNew(): Promise<void> {
    await this.filterNew.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'new');
  }

  async clickFilterAwaiting(): Promise<void> {
    await this.filterAwaiting.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === 'awaiting');
  }

  async clickFilterAll(): Promise<void> {
    await this.filterAll.click();
    await this.page.waitForURL((url) => url.searchParams.get('filter') === null);
  }

  async openRow(id: string): Promise<AdminFeedbackDetailPage> {
    await this.row(id).click();
    const detail = new AdminFeedbackDetailPage(this.page);
    await expect(detail.container).toBeVisible();
    return detail;
  }
}

export class AdminFeedbackDetailPage {
  readonly page: Page;
  readonly container: Locator;
  readonly detail: Locator;
  readonly content: Locator;
  readonly contactEmail: Locator;
  readonly delivery: Locator;
  readonly notifyError: Locator;
  readonly markResponded: Locator;
  readonly respondedAt: Locator;
  readonly back: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('admin-feedback-detail-page');
    this.detail = page.getByTestId('admin-feedback-detail');
    this.content = page.getByTestId('admin-feedback-content');
    this.contactEmail = page.getByTestId('admin-feedback-contact-email');
    this.delivery = page.getByTestId('admin-feedback-delivery');
    this.notifyError = page.getByTestId('admin-feedback-notify-error');
    this.markResponded = page.getByTestId('admin-feedback-mark-responded');
    this.respondedAt = page.getByTestId('admin-feedback-responded-at');
    this.back = page.getByTestId('admin-feedback-back');
  }

  async goto(id: string): Promise<void> {
    await this.page.goto(`/admin/feedback/${id}`);
    await expect(this.container).toBeVisible();
  }
}
