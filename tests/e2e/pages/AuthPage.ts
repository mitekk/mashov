import { Page, Locator, expect } from '@playwright/test';

export class AuthPage {
  readonly page: Page;
  readonly schoolSelector: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.schoolSelector = page.getByTestId('sign-in-school-selector');
    this.usernameInput = page.getByTestId('sign-in-username');
    this.passwordInput = page.getByTestId('sign-in-password');
    this.submitButton = page.getByTestId('sign-in-submit');
    this.errorMessage = page.getByTestId('sign-in-error');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/auth/sign-in');
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  async fillSchool(schoolName: string): Promise<void> {
    await this.schoolSelector.fill(schoolName);
  }

  async selectSchoolOption(semel: number): Promise<void> {
    await this.page.getByRole('option', { name: new RegExp(String(semel)) }).click();
  }

  async fillCredentials(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
  }

  async submit(): Promise<void> {
    await this.submitButton.click();
  }

  async signIn(schoolName: string, semel: number, username: string, password: string): Promise<void> {
    await this.navigate();
    await this.fillSchool(schoolName);
    await this.selectSchoolOption(semel);
    await this.fillCredentials(username, password);
    await this.submit();
  }
}
