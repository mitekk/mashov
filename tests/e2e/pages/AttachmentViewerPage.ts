import { Page, Locator, expect } from '@playwright/test';

/**
 * Page object for the in-app attachment viewer and the shared attachment list.
 *
 * `data-testid` selectors only, per `.claude/rules/testing.md`.
 */
export class AttachmentViewerPage {
  readonly page: Page;

  readonly list: Locator;
  readonly viewer: Locator;
  readonly title: Locator;
  readonly counter: Locator;

  readonly downloadButton: Locator;
  readonly printButton: Locator;
  readonly closeButton: Locator;
  readonly previousButton: Locator;
  readonly nextButton: Locator;

  readonly imagePreview: Locator;
  readonly pdfPreview: Locator;
  readonly textPreview: Locator;
  readonly docxPreview: Locator;
  readonly unsupportedCard: Locator;
  readonly unsupportedDownloadButton: Locator;

  readonly loading: Locator;
  readonly error: Locator;
  readonly errorFallbackLink: Locator;
  readonly printFrame: Locator;

  constructor(page: Page) {
    this.page = page;

    this.list = page.getByTestId('attachment-list');
    this.viewer = page.getByTestId('attachment-viewer');
    this.title = page.getByTestId('attachment-viewer-title');
    this.counter = page.getByTestId('attachment-viewer-counter');

    this.downloadButton = page.getByTestId('attachment-download-button');
    this.printButton = page.getByTestId('attachment-print-button');
    this.closeButton = page.getByTestId('attachment-close-button');
    this.previousButton = page.getByTestId('attachment-prev-button');
    this.nextButton = page.getByTestId('attachment-next-button');

    this.imagePreview = page.getByTestId('attachment-preview-image');
    this.pdfPreview = page.getByTestId('attachment-preview-pdf');
    this.textPreview = page.getByTestId('attachment-preview-text');
    // The docx render lives in an open shadow root; Playwright's testid and
    // text engines pierce it, so no special selector is needed.
    this.docxPreview = page.getByTestId('attachment-preview-docx');
    this.unsupportedCard = page.getByTestId('attachment-preview-unsupported');
    this.unsupportedDownloadButton = page.getByTestId('attachment-unsupported-download-button');

    this.loading = page.getByTestId('attachment-loading');
    this.error = page.getByTestId('attachment-error');
    this.errorFallbackLink = page.getByTestId('attachment-error-fallback-link');
    this.printFrame = page.getByTestId('attachment-print-frame');
  }

  item(fileId: string): Locator {
    return this.page.getByTestId(`attachment-item-${fileId}`);
  }

  /** Click an attachment row and wait for the viewer to open. */
  async open(fileId: string): Promise<void> {
    await this.item(fileId).click();
    await expect(this.viewer).toBeVisible();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.viewer).toBeHidden();
  }

  /** In RTL, ArrowLeft advances to the next file. */
  async pressAdvanceKey(): Promise<void> {
    await this.page.keyboard.press('ArrowLeft');
  }

  /** In RTL, ArrowRight goes back to the previous file. */
  async pressBackKey(): Promise<void> {
    await this.page.keyboard.press('ArrowRight');
  }
}
