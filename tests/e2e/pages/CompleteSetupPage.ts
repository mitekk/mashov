import { Page, Locator, expect } from '@playwright/test';

/**
 * The forced credential screen: `/auth/complete-setup?semel=…&mode=…`.
 *
 * Reached when Mashov accepts the password but will not let the parent in
 * until something changes — `403 Reason: ChangePass` gives `mode=password`,
 * and `CreateUsername` / `SetUsernameAndPass` give `mode=credentials`, which
 * adds the new-username field.
 *
 * As on the MFA screen, neither the password nor the username rides in the
 * query string: for these accounts the username IS the parent's national ID
 * number, which would otherwise sit in browser history and every proxy access
 * log. Both are asked for on the screen.
 *
 * This is the page that changes a third party's Mashov password, and it was
 * the only one of the five in-app auth screens with no end-to-end cover.
 */
export class CompleteSetupPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly currentPasswordInput: Locator;
  readonly newUsernameInput: Locator;
  readonly newPasswordInput: Locator;
  readonly policyChecklist: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly startAgain: Locator;
  readonly backToSignIn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByTestId('complete-setup-username');
    this.currentPasswordInput = page.getByTestId('complete-setup-current-password');
    this.newUsernameInput = page.getByTestId('complete-setup-new-username');
    this.newPasswordInput = page.getByTestId('complete-setup-new-password');
    this.policyChecklist = page.getByTestId('complete-setup-policy-checklist');
    this.submitButton = page.getByTestId('complete-setup-submit');
    this.errorMessage = page.getByTestId('complete-setup-error');
    this.startAgain = page.getByTestId('complete-setup-start-again');
    this.backToSignIn = page.getByTestId('complete-setup-back-to-sign-in');
  }

  async navigate(semel: number, mode: 'password' | 'credentials' = 'password'): Promise<void> {
    const query = new URLSearchParams({ semel: String(semel), mode });
    await this.page.goto(`/auth/complete-setup?${query.toString()}`);
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  /** Navigate with no school, to reach the "start again" state. */
  async navigateWithoutSemel(): Promise<void> {
    await this.page.goto('/auth/complete-setup');
    await expect(this.startAgain).toBeVisible({ timeout: 15_000 });
  }

  async changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.usernameInput.fill(username);
    await this.currentPasswordInput.fill(currentPassword);
    await this.newPasswordInput.fill(newPassword);
    await this.submitButton.click();
  }

  async rule(id: string): Promise<Locator> {
    return this.page.getByTestId(`complete-setup-rule-${id}`);
  }
}
