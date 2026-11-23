import { Page, Locator, expect } from '@playwright/test';

/**
 * The MFA challenge screen: `/auth/mfa?cid=…&semel=…`.
 *
 * Neither the password NOR the username is in that query string. The password
 * because it has no business in a URL; the username because for these accounts
 * it IS the parent's national ID number, which would then sit in browser
 * history and in every reverse-proxy access log. Both are asked for on the
 * screen instead.
 */
export class MfaPage {
  readonly page: Page;
  readonly sendEmail: Locator;
  readonly sendSms: Locator;
  readonly sentNote: Locator;
  readonly codeInput: Locator;
  readonly usernameInput: Locator;
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
    this.usernameInput = page.getByTestId('mfa-username');
    this.passwordInput = page.getByTestId('mfa-password');
    this.submitButton = page.getByTestId('mfa-submit');
    this.errorMessage = page.getByTestId('mfa-error');
    this.startAgain = page.getByTestId('mfa-start-again');
    this.backToSignIn = page.getByTestId('mfa-back-to-sign-in');
  }

  async navigate(challengeId: string, semel: number): Promise<void> {
    const query = new URLSearchParams({ cid: challengeId, semel: String(semel) });
    await this.page.goto(`/auth/mfa?${query.toString()}`);
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  /** Navigate with no challenge id, to reach the "start again" state. */
  async navigateWithoutChallenge(): Promise<void> {
    await this.page.goto('/auth/mfa');
    await expect(this.startAgain).toBeVisible({ timeout: 15_000 });
  }

  async verify(username: string, code: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.codeInput.fill(code);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
