import { Page, Locator, expect } from '@playwright/test';

/**
 * Step 1 of in-app password recovery: `/auth/forgot-password`.
 *
 * `data-testid` selectors only, per `.claude/rules/testing.md` — the Hebrew
 * copy on this screen is a security control (see `privacyNote`) and will be
 * reworded; a text matcher would make that a test failure.
 */
export class ForgotPasswordPage {
  readonly page: Page;
  readonly schoolSelector: Locator;
  readonly idNumberInput: Locator;
  /**
   * Where the code goes. Mashov checks it against the school's record rather
   * than sending to a contact it already holds -- the opposite of the OTP and
   * MFA flows, and the field whose absence meant recovery never delivered.
   */
  readonly destinationInput: Locator;
  readonly emailChannel: Locator;
  readonly smsChannel: Locator;
  /** The enumeration-safe "if the details are correct" line. */
  readonly privacyNote: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly backToSignIn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.schoolSelector = page.getByTestId('forgot-password-school-selector');
    this.idNumberInput = page.getByTestId('forgot-password-id-number');
    this.destinationInput = page.getByTestId('forgot-password-destination');
    this.emailChannel = page.getByTestId('forgot-password-channel-email');
    this.smsChannel = page.getByTestId('forgot-password-channel-sms');
    this.privacyNote = page.getByTestId('forgot-password-privacy-note');
    this.submitButton = page.getByTestId('forgot-password-submit');
    this.errorMessage = page.getByTestId('forgot-password-error');
    this.backToSignIn = page.getByTestId('forgot-password-back-to-sign-in');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/auth/forgot-password');
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  async selectSchool(schoolName: string, semel: number): Promise<void> {
    await this.schoolSelector.fill(schoolName);
    await this.page.getByTestId(`school-option-${semel}`).click();
  }

  async requestCode(
    schoolName: string,
    semel: number,
    idNumber: string,
    channel: 'email' | 'sms' = 'email',
    destination = channel === 'sms' ? '0501234567' : 'parent@example.com',
  ): Promise<void> {
    await this.selectSchool(schoolName, semel);
    await this.idNumberInput.fill(idNumber);
    await (channel === 'sms' ? this.smsChannel : this.emailChannel).click();
    await this.destinationInput.fill(destination);
    await this.submitButton.click();
  }
}
