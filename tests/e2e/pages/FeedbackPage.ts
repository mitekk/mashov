import { Page, Locator, expect } from '@playwright/test';

/**
 * The feedback channel: a header icon on every authenticated screen, and the
 * dialog behind it.
 *
 * There is no route of its own -- the trigger lives in `AppHeader`, the
 * app-wide sticky header -- so this object takes whichever page the parent is
 * already on rather than navigating.
 *
 * `launcherButton` is the `header-menu-feedback` item inside the header's
 * profile menu, which is where every header action lives at every width. One
 * dialog and one thank-you banner however it is opened, because the state
 * lives in `FeedbackDialogProvider`.
 */
export class FeedbackPage {
  readonly page: Page;
  readonly profileTrigger: Locator;
  readonly launcherButton: Locator;
  readonly dialog: Locator;
  readonly subjectSelect: Locator;
  readonly subjectOtherInput: Locator;
  readonly emailInput: Locator;
  readonly contentTextarea: Locator;
  readonly contentCounter: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly error: Locator;
  readonly thanks: Locator;
  readonly thanksDismiss: Locator;

  constructor(page: Page) {
    this.page = page;
    this.profileTrigger = page.getByTestId('header-profile-trigger');
    this.launcherButton = page.getByTestId('header-menu-feedback');
    this.dialog = page.getByTestId('feedback-dialog');
    this.subjectSelect = page.getByTestId('feedback-subject-select');
    this.subjectOtherInput = page.getByTestId('feedback-subject-other-input');
    this.emailInput = page.getByTestId('feedback-email-input');
    this.contentTextarea = page.getByTestId('feedback-content-textarea');
    this.contentCounter = page.getByTestId('feedback-content-counter');
    this.submitButton = page.getByTestId('feedback-submit-button');
    this.cancelButton = page.getByTestId('feedback-cancel-button');
    this.error = page.getByTestId('feedback-error');
    this.thanks = page.getByTestId('feedback-thanks');
    this.thanksDismiss = page.getByTestId('feedback-thanks-dismiss');
  }

  /** Open the header's profile menu, press שליחת משוב, wait for the form. */
  async open(): Promise<void> {
    await this.profileTrigger.click();
    // Gated on `me`, so it appears a paint after the trigger does.
    await expect(this.launcherButton).toBeVisible();
    await this.launcherButton.click();
    await expect(this.dialog).toBeVisible();
  }

  async pickSubject(code: string): Promise<void> {
    await this.subjectSelect.selectOption(code);
  }

  async fillContent(text: string): Promise<void> {
    await this.contentTextarea.fill(text);
  }

  async submit(): Promise<void> {
    await this.submitButton.click();
  }

  async dismissThanks(): Promise<void> {
    await this.thanksDismiss.click();
  }
}
