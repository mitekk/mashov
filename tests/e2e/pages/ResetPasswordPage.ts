import { Page, Locator, expect } from '@playwright/test';

/**
 * Step 2 of in-app password recovery: `/auth/reset-password?rid=…&semel=…`.
 *
 * The `rid` is an opaque, single-use, server-TTL'd handle, which is why it is
 * safe in a URL in a way a verification code is not — so navigation here takes
 * one.
 */
export class ResetPasswordPage {
  readonly page: Page;
  readonly codeInput: Locator;
  readonly secondCodeInput: Locator;
  readonly newPasswordInput: Locator;
  readonly policyChecklist: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly successMessage: Locator;
  readonly usernameNote: Locator;
  readonly goToSignIn: Locator;
  readonly startAgain: Locator;

  constructor(page: Page) {
    this.page = page;
    this.codeInput = page.getByTestId('reset-password-code');
    this.secondCodeInput = page.getByTestId('reset-password-second-code');
    this.newPasswordInput = page.getByTestId('reset-password-new-password');
    this.policyChecklist = page.getByTestId('reset-password-policy-checklist');
    this.submitButton = page.getByTestId('reset-password-submit');
    this.errorMessage = page.getByTestId('reset-password-error');
    this.successMessage = page.getByTestId('reset-password-success');
    this.usernameNote = page.getByTestId('reset-password-username');
    this.goToSignIn = page.getByTestId('reset-password-go-to-sign-in');
    this.startAgain = page.getByTestId('reset-password-start-again');
  }

  async navigate(recoveryId: string, semel?: number): Promise<void> {
    const query = new URLSearchParams({ rid: recoveryId });
    if (semel !== undefined) query.set('semel', String(semel));
    await this.page.goto(`/auth/reset-password?${query.toString()}`);
  }

  /** Navigate with no handle at all, to reach the "start again" state. */
  async navigateWithoutHandle(): Promise<void> {
    await this.page.goto('/auth/reset-password');
    await expect(this.startAgain).toBeVisible({ timeout: 15_000 });
  }

  /** One rule's checklist item; `data-satisfied` is `'true'` or `'false'`. */
  rule(id: 'minLength' | 'letter' | 'digit' | 'noUsername'): Locator {
    return this.page.getByTestId(`reset-password-rule-${id}`);
  }

  async submitNewPassword(code: string, newPassword: string): Promise<void> {
    await this.codeInput.fill(code);
    await this.newPasswordInput.fill(newPassword);
    await this.submitButton.click();
  }
}
