import { Page, Locator, expect } from '@playwright/test';

/**
 * The `/more/telegram` wizard, and the `/more` card that leads into it.
 *
 * The steps are component state rather than URL segments -- deliberately, since
 * step 3 is a wait on an action taken in another app and a back button there
 * would offer a code that has already been spent (ADR-0033). So there is no
 * `goto` per step: a test walks in through the card like a parent does.
 *
 * Child locators are keyed by `studentGuid` rather than by position, following
 * MorePage's `semel` reasoning: row order follows the roster, so an index would
 * quietly start asserting about the other child.
 */
export class TelegramSetupPage {
  readonly page: Page;

  // --- the /more entry point ---
  readonly card: Locator;
  readonly connectLink: Locator;
  readonly addChildLink: Locator;
  readonly disconnectButton: Locator;
  readonly disconnectModal: Locator;
  readonly confirmDisconnectButton: Locator;
  readonly cancelDisconnectButton: Locator;
  readonly disconnectError: Locator;
  readonly toggleError: Locator;

  // --- the wizard ---
  readonly wizard: Locator;
  readonly backButton: Locator;
  readonly introStep: Locator;
  readonly introContinueButton: Locator;
  readonly childrenStep: Locator;
  readonly childrenContinueButton: Locator;
  readonly childrenError: Locator;
  readonly childrenEmpty: Locator;
  readonly startStep: Locator;
  readonly startButton: Locator;
  readonly startWaiting: Locator;
  readonly startRetryButton: Locator;
  readonly doneStep: Locator;
  readonly doneChildren: Locator;
  readonly doneBackButton: Locator;
  readonly doneDeliveryOff: Locator;
  readonly doneConfirmationPending: Locator;
  readonly doneConfirmationFailed: Locator;

  constructor(page: Page) {
    this.page = page;

    this.card = page.getByTestId('telegram-card');
    this.connectLink = page.getByTestId('telegram-card-connect-link');
    this.addChildLink = page.getByTestId('telegram-card-add-child-link');
    this.disconnectButton = page.getByTestId('telegram-card-disconnect-btn');
    this.disconnectModal = page.getByTestId('telegram-disconnect-modal');
    this.confirmDisconnectButton = page.getByTestId('telegram-disconnect-confirm-btn');
    this.cancelDisconnectButton = page.getByTestId('telegram-disconnect-cancel-btn');
    this.disconnectError = page.getByTestId('telegram-disconnect-error');
    this.toggleError = page.getByTestId('telegram-card-toggle-error');

    this.wizard = page.getByTestId('telegram-setup-page');
    this.backButton = page.getByTestId('telegram-back-btn');
    this.introStep = page.getByTestId('telegram-step-intro');
    this.introContinueButton = page.getByTestId('telegram-intro-continue-btn');
    this.childrenStep = page.getByTestId('telegram-step-children');
    this.childrenContinueButton = page.getByTestId('telegram-children-continue-btn');
    this.childrenError = page.getByTestId('telegram-children-error');
    this.childrenEmpty = page.getByTestId('telegram-children-empty');
    this.startStep = page.getByTestId('telegram-step-start');
    this.startButton = page.getByTestId('telegram-start-btn');
    this.startWaiting = page.getByTestId('telegram-start-waiting');
    this.startRetryButton = page.getByTestId('telegram-start-retry-btn');
    this.doneStep = page.getByTestId('telegram-step-done');
    this.doneChildren = page.getByTestId('telegram-done-children');
    this.doneBackButton = page.getByTestId('telegram-done-back-btn');
    this.doneDeliveryOff = page.getByTestId('telegram-done-delivery-off');
    this.doneConfirmationPending = page.getByTestId('telegram-done-confirmation-pending');
    this.doneConfirmationFailed = page.getByTestId('telegram-done-confirmation-failed');
  }

  /** A subscription row on the `/more` card. */
  cardRow(studentGuid: string): Locator {
    return this.page.getByTestId(`telegram-card-row-${studentGuid}`);
  }

  /** The per-child on/off switch on the `/more` card. */
  cardToggle(studentGuid: string): Locator {
    return this.page.getByTestId(`telegram-card-toggle-${studentGuid}`);
  }

  /** The per-child tick on the wizard's second step. */
  childTick(studentGuid: string): Locator {
    return this.page.getByTestId(`telegram-child-toggle-${studentGuid}`);
  }

  async openMore(): Promise<void> {
    await this.page.goto('/more');
    await expect(this.card).toBeVisible();
  }

  /** In through the card, the way a parent arrives. */
  async openWizardFromMore(): Promise<void> {
    await this.openMore();
    await this.connectLink.click();
    await expect(this.introStep).toBeVisible();
  }

  /** Step 1 -> step 2. */
  async reachChildrenStep(): Promise<void> {
    await this.openWizardFromMore();
    await this.introContinueButton.click();
    await expect(this.childrenStep).toBeVisible();
  }

  /** Step 1 -> step 2 -> step 3, minting on the way. */
  async reachStartStep(): Promise<void> {
    await this.reachChildrenStep();
    await this.childrenContinueButton.click();
    await expect(this.startStep).toBeVisible();
  }
}
