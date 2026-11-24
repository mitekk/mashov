import { Page, Locator, expect } from '@playwright/test';

/**
 * The feedback channel: a header icon on every authenticated screen, and the
 * dialog behind it.
 *
 * There is no route of its own -- the launcher lives in `AppHeader`, the
 * app-wide sticky header -- so this object takes whichever page the parent is
 * already on rather than navigating.
 *
 * `launcherButton` is the inline trigger, visible from `sm` up. Below `sm` the
 * same dialog is opened from `header-menu-feedback` inside the header's
 * overflow menu; both reach one dialog and one thank-you banner, because the
 * state lives in `FeedbackDialogProvider`. Every spec using this class runs in
 * the 1280 `chromium` project, so the inline trigger is the one it needs.
 */
export class FeedbackPage {
  readonly page: Page;
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
    this.launcherButton = page.getByTestId('feedback-launcher-button');
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

  /** Press the header icon and wait for the form. */
  async open(): Promise<void> {
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
