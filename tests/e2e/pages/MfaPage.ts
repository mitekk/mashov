import { Page, Locator, expect } from '@playwright/test';

/**
 * The MFA challenge screen: `/auth/mfa?cid=…&semel=…&username=…`.
 *
 * The password is deliberately NOT in that query string. It is asked for again
 * on the screen, because our background sync stores it and because a password
 * has no business in a URL or in browser storage.
 */
export class MfaPage {
  readonly page: Page;
  readonly sendEmail: Locator;
  readonly sendSms: Locator;
  readonly sentNote: Locator;
  readonly codeInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly startAgain: Locator;
  readonly backToSignIn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sendEmail = page.getByTestId('mfa-send-email');
    this.sendSms = page.getByTestId('mfa-send-sms');
    this.sentNote = page.getByTestId('mfa-sent-note');
    this.codeInput = page.getByTestId('mfa-code');
    this.passwordInput = page.getByTestId('mfa-password');
    this.submitButton = page.getByTestId('mfa-submit');
    this.errorMessage = page.getByTestId('mfa-error');
    this.startAgain = page.getByTestId('mfa-start-again');
    this.backToSignIn = page.getByTestId('mfa-back-to-sign-in');
  }

  async navigate(challengeId: string, semel: number, username: string): Promise<void> {
    const query = new URLSearchParams({ cid: challengeId, semel: String(semel), username });
    await this.page.goto(`/auth/mfa?${query.toString()}`);
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  /** Navigate with no challenge id, to reach the "start again" state. */
  async navigateWithoutChallenge(): Promise<void> {
    await this.page.goto('/auth/mfa');
    await expect(this.startAgain).toBeVisible({ timeout: 15_000 });
  }

  async verify(code: string, password: string): Promise<void> {
    await this.codeInput.fill(code);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
