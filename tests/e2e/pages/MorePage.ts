import { Page, Locator, expect } from '@playwright/test';

/**
 * The `/more` screen, which is where a household's schools are managed.
 *
 * Every school locator is keyed by `semel` rather than by position: the row
 * order follows last sign-in, so an index would silently start asserting about
 * the other school the moment a parent signs in with it.
 */
export class MorePage {
  readonly page: Page;
  readonly morePageContainer: Locator;
  readonly schoolsCard: Locator;
  readonly addSchoolButton: Locator;
  readonly bulkDisconnectButton: Locator;
  readonly signOutButton: Locator;
  readonly unlinkModal: Locator;
  readonly unlinkError: Locator;
  readonly disconnectError: Locator;
  /** The sync-status card in the aside; starts folded behind its header. */
  readonly sourceHealthList: Locator;
  readonly sourceHealthToggle: Locator;
  readonly sourceHealthSummary: Locator;

  constructor(page: Page) {
    this.page = page;
    this.morePageContainer = page.getByTestId('more-page');
    this.schoolsCard = page.getByTestId('settings-schools-card');
    this.addSchoolButton = page.getByTestId('settings-add-school-btn');
    this.bulkDisconnectButton = page.getByTestId('settings-disconnect-btn');
    this.signOutButton = page.getByTestId('settings-signout-btn');
    this.unlinkModal = page.getByTestId('settings-unlink-modal');
    this.unlinkError = page.getByTestId('settings-unlink-error');
    this.disconnectError = page.getByTestId('settings-disconnect-error');
    this.sourceHealthList = page.getByTestId('source-health-list');
    this.sourceHealthToggle = page.getByTestId('source-health-toggle');
    this.sourceHealthSummary = page.getByTestId('source-health-summary');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/more');
    await expect(this.morePageContainer).toBeVisible();
  }

  schoolRow(semel: number): Locator {
    return this.page.getByTestId(`settings-school-row-${semel}`);
  }

  schoolName(semel: number): Locator {
    return this.page.getByTestId(`settings-school-name-${semel}`);
  }

  schoolChildrenCount(semel: number): Locator {
    return this.page.getByTestId(`settings-school-children-count-${semel}`);
  }

  /** Present only while that school's first sync has not finished. */
  schoolSyncing(semel: number): Locator {
    return this.page.getByTestId(`settings-school-syncing-${semel}`);
  }

  unlinkButton(semel: number): Locator {
    return this.page.getByTestId(`settings-school-unlink-btn-${semel}`);
  }

  confirmUnlinkButton(semel: number): Locator {
    return this.page.getByTestId(`settings-unlink-confirm-btn-${semel}`);
  }

  /** Open the confirm for one school and go through with it. */
  async unlinkSchool(semel: number): Promise<void> {
    await this.unlinkButton(semel).click();
    await expect(this.unlinkModal).toBeVisible();
    await this.confirmUnlinkButton(semel).click();
  }

  async listedSchoolNames(): Promise<string[]> {
    return this.schoolsCard.locator('[data-testid^="settings-school-name-"]').allTextContents();
  }
}
