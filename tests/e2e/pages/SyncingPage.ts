import { Page, Locator, expect } from '@playwright/test';

export class SyncingPage {
  readonly page: Page;
  readonly progressText: Locator;
  readonly skipButton: Locator;
  readonly currentTask: Locator;
  readonly error: Locator;
  readonly continueButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.progressText = page.getByTestId('syncing-progress-text');
    this.skipButton = page.getByTestId('syncing-skip-button');
    this.currentTask = page.getByTestId('syncing-current-task');
    this.error = page.getByTestId('syncing-error');
    this.continueButton = page.getByTestId('syncing-continue-button');
  }

  /** Navigates straight to the screen, bypassing the sign-in form. */
  async navigate(search = ''): Promise<void> {
    await this.page.goto(`/auth/syncing${search}`);
    await expect(this.progressText).toBeVisible({ timeout: 10_000 });
  }

  async waitForVisible(): Promise<void> {
    await this.page.waitForURL('**/auth/syncing', { timeout: 10_000 });
    await expect(this.progressText).toBeVisible({ timeout: 10_000 });
  }

  async waitForSkipButton(): Promise<void> {
    // Skip button appears after 10 seconds per PRD FR-13
    await expect(this.skipButton).toBeVisible({ timeout: 15_000 });
  }

  async clickSkip(): Promise<void> {
    await this.skipButton.click();
  }

  async clickContinue(): Promise<void> {
    await this.continueButton.click();
  }
}
