import { Page, Locator, expect } from '@playwright/test';

export class ConversationPage {
  readonly page: Page;
  readonly conversationContainer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.conversationContainer = page.getByTestId('conversation-page');
  }

  async navigate(conversationId: string): Promise<void> {
    await this.page.goto(`/inbox/${conversationId}`);
    await expect(this.conversationContainer).toBeVisible();
  }

  markNewButton(conversationId: string): Locator {
    return this.page.getByTestId(`mark-new-${conversationId}`);
  }
}
