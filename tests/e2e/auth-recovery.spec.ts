/**
 * In-app Mashov auth — recovery, MFA and the captcha escape hatch, E2E.
 *
 * What these cover that the component tests cannot: the real Next routes, the
 * real `apiFetch`, and the real navigations between the four screens. In
 * particular `apiFetch`'s hard redirect on a 401 — the reason every route in
 * this surface answers 400/422/429/502 instead — only exists in the browser.
 *
 * Every `/api/v1/*` call is intercepted with `page.route()`, as
 * `auth.spec.ts` already does. Nothing here reaches Mashov.
 *
 * `data-testid` selectors only, via the page objects.
 */

import { test, expect, type Page } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { MfaPage } from './pages/MfaPage';

const SCHOOL = { semel: 540175, name: 'בית ספר לדוגמה', years: [2026] };
const ID_NUMBER = '303977367';
const GOOD_PASSWORD = 'secret1';
const RECOVERY_ID = '11111111-1111-4111-8111-111111111111';

type Envelope = { code: string; message: string; details?: unknown[]; challengeId?: string };

function errorBody(code: string, extra: Partial<Envelope> = {}) {
  return { error: { code, message: code, details: [], ...extra } };
}

/** The school picker is populated from this on every one of these screens. */
async function routeSchools(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/schools', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SCHOOL]) }),
  );
}

async function routeJson(
  page: Page,
  pattern: string,
  status: number,
  body: unknown,
): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test.describe('in-app password recovery', () => {
  test.beforeEach(async ({ page }) => {
    await routeSchools(page);
  });

  test('sign-in offers a way out for a forgotten password', async ({ page }) => {
    const auth = new AuthPage(page);
    await auth.navigate();

    await page.getByTestId('sign-in-forgot-password').click();

    await expect(page).toHaveURL(/\/auth\/forgot-password$/);
    await expect(new ForgotPasswordPage(page).submitButton).toBeVisible();
  });

  test('step 1 never confirms that a code was sent', async ({ page }) => {
    // Enumeration safety is a property of the SCREEN as much as of the 202:
    // copy saying "a code was sent to your email" would hand back whether the
    // ID number exists at that school.
    const forgot = new ForgotPasswordPage(page);
    await routeJson(page, '**/api/v1/auth/credential-recoveries', 202, {
      recoveryId: RECOVERY_ID,
      requiresSecondChannel: false,
      channel: 'email',
    });

    await forgot.navigate();
    await expect(forgot.privacyNote).toContainText('אם הפרטים נכונים');

    await forgot.requestCode(SCHOOL.name, SCHOOL.semel, ID_NUMBER);

    // Straight to step 2, carrying the opaque handle and nothing else.
    await expect(page).toHaveURL(new RegExp(`rid=${RECOVERY_ID}`));
    await expect(page).toHaveURL(new RegExp(`semel=${SCHOOL.semel}`));
    await expect(page).not.toHaveURL(new RegExp(ID_NUMBER));
  });

  test('step 2 refuses a policy-breaking password before asking the server', async ({
    page,
  }) => {
    // Mashov answers 404 for a policy violation exactly as for a bad code, and
    // the code is single-use. The checklist is what stops the parent getting
    // there.
    const reset = new ResetPasswordPage(page);
    let called = false;
    await page.route('**/api/v1/auth/credential-recoveries/*/password', (route) => {
      called = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);
    await reset.newPasswordInput.fill('abc');

    await expect(reset.rule('minLength')).toHaveAttribute('data-satisfied', 'false');
    await expect(reset.rule('letter')).toHaveAttribute('data-satisfied', 'true');
    await expect(reset.rule('digit')).toHaveAttribute('data-satisfied', 'false');

    await reset.codeInput.fill('ABC123');
    await reset.submitButton.click();

    await expect(reset.errorMessage).toBeVisible();
    expect(called).toBe(false);
  });

  test('a completed reset chains straight into sign-in', async ({ page }) => {
    // The server deliberately mints no session -- whoever completed recovery
    // proved control of the school's contact details, not ownership of our
    // household. So the auto sign-in is a SECOND request, made by the form with
    // the password it still holds in memory, and on success it navigates. Which
    // is why the username panel is asserted in the next test instead: here it
    // is torn down by the navigation it triggers.
    const reset = new ResetPasswordPage(page);
    // Catch-all FIRST: Playwright matches the LAST registered route, so a
    // broad pattern registered after a specific one silently shadows it --
    // which is what made this test's first version see a reset response with
    // no username in it.
    await routeJson(page, '**/api/v1/**', 200, {});
    await routeJson(page, '**/api/v1/auth/credential-recoveries/*/password', 200, {
      ok: true,
      username: ID_NUMBER,
    });
    await routeJson(page, '**/api/v1/auth/login', 200, {
      ok: true,
      isFirstLogin: false,
    });

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);

    // The REQUEST is the observable, not the URL afterwards: `router.push('/')`
    // with no session cookie is immediately redirected back to sign-in by the
    // middleware, so asserting a landing URL would be asserting the auth
    // middleware rather than the chain.
    const loginRequest = page.waitForRequest(
      (request) =>
        request.url().includes('/api/v1/auth/login') && request.method() === 'POST',
    );
    await reset.submitNewPassword('ABC123', GOOD_PASSWORD);

    expect((await loginRequest).postDataJSON()).toEqual({
      semel: SCHOOL.semel,
      username: ID_NUMBER,
      password: GOOD_PASSWORD,
    });
  });

  test('a reset with no auto sign-in still offers a manual one', async ({ page }) => {
    const reset = new ResetPasswordPage(page);
    await routeJson(page, '**/api/v1/auth/credential-recoveries/*/password', 200, {
      ok: true,
      username: ID_NUMBER,
    });
    // The reset LANDED; only the convenience sign-in failed. The parent must
    // not be told their password change failed when it did not.
    await routeJson(page, '**/api/v1/auth/login', 502, errorBody('UPSTREAM_ERROR'));

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);
    await reset.submitNewPassword('ABC123', GOOD_PASSWORD);

    await expect(reset.successMessage).toContainText('הסיסמה עודכנה במשוב');
    // The username is worth surfacing: a parent who forgot their password
    // often does not remember this either.
    await expect(reset.usernameNote).toContainText(ID_NUMBER);
    await expect(reset.goToSignIn).toHaveAttribute('href', '/auth/sign-in');
  });

  test('an expired handle sends the parent back to the start', async ({ page }) => {
    const reset = new ResetPasswordPage(page);
    await routeJson(
      page,
      '**/api/v1/auth/credential-recoveries/*/password',
      400,
      errorBody('RECOVERY_SESSION_EXPIRED'),
    );

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);
    await reset.submitNewPassword('ABC123', GOOD_PASSWORD);

    await expect(reset.startAgain).toHaveAttribute('href', '/auth/forgot-password');
  });

  test('a bare reset URL renders a start-again state, not a form', async ({ page }) => {
    const reset = new ResetPasswordPage(page);
    await reset.navigateWithoutHandle();

    await expect(reset.startAgain).toBeVisible();
    await expect(reset.submitButton).toHaveCount(0);
  });

  test('an outage is never reported as a wrong code', async ({ page }) => {
    // The parent has already burned a single-use code; a false "wrong code" is
    // unrecoverable.
    const reset = new ResetPasswordPage(page);
    await routeJson(
      page,
      '**/api/v1/auth/credential-recoveries/*/password',
      502,
      errorBody('UPSTREAM_ERROR'),
    );

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);
    await reset.submitNewPassword('ABC123', GOOD_PASSWORD);

    await expect(reset.errorMessage).toContainText('משוב אינו זמין כרגע');
    // Still on the form, with the code intact.
    await expect(reset.codeInput).toHaveValue('ABC123');
  });

  test('the two-channel path reveals a second code field from the server', async ({
    page,
  }) => {
    const reset = new ResetPasswordPage(page);
    let callCount = 0;
    await page.route('**/api/v1/auth/credential-recoveries/*/password', (route) => {
      callCount += 1;
      if (callCount === 1) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify(errorBody('SECOND_CODE_REQUIRED')),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, username: ID_NUMBER }),
      });
    });
    await routeJson(page, '**/api/v1/auth/login', 502, errorBody('UPSTREAM_ERROR'));

    await reset.navigate(RECOVERY_ID, SCHOOL.semel);
    await expect(reset.secondCodeInput).toHaveCount(0);

    await reset.submitNewPassword('AAA111', GOOD_PASSWORD);
    await expect(reset.secondCodeInput).toBeVisible();

    await reset.secondCodeInput.fill('BBB222');
    await reset.submitButton.click();
    await expect(reset.successMessage).toBeVisible();
  });
});

test.describe('in-app MFA', () => {
  test.beforeEach(async ({ page }) => {
    await routeSchools(page);
  });

  test('a challenged sign-in lands on the code screen', async ({ page }) => {
    const auth = new AuthPage(page);
    await routeJson(
      page,
      '**/api/v1/auth/login',
      400,
      errorBody('MFA_REQUIRED', { challengeId: 'ch-e2e' }),
    );

    await auth.signIn(SCHOOL.name, SCHOOL.semel, ID_NUMBER, GOOD_PASSWORD);

    await expect(page).toHaveURL(/\/auth\/mfa\?/);
    await expect(page).toHaveURL(/cid=ch-e2e/);
    // Neither the password nor the ID number travels in the URL: one has no
    // business there, the other would land in browser history and every
    // reverse-proxy access log.
    await expect(page).not.toHaveURL(new RegExp(GOOD_PASSWORD));
    await expect(page).not.toHaveURL(new RegExp(ID_NUMBER));
  });

  test('the code screen asks for the username and password again', async ({ page }) => {
    const mfa = new MfaPage(page);
    await mfa.navigate('ch-e2e', SCHOOL.semel);

    await expect(mfa.usernameInput).toBeVisible();
    await expect(mfa.passwordInput).toHaveAttribute('type', 'password');
    await expect(mfa.codeInput).toHaveAttribute('autocomplete', 'one-time-code');
  });

  test('sending a code reports which channel it went to', async ({ page }) => {
    const mfa = new MfaPage(page);
    await routeJson(page, '**/api/v1/auth/mfa-challenges/*/code', 202, { ok: true });

    await mfa.navigate('ch-e2e', SCHOOL.semel);
    await mfa.sendSms.click();

    await expect(mfa.sentNote).toBeVisible();
  });

  test('a wrong code keeps the parent on the screen', async ({ page }) => {
    // The 400-not-401 rule, observable only in a browser: a 401 would send
    // `apiFetch` into its hard redirect and lose the typed code.
    const mfa = new MfaPage(page);
    await routeJson(
      page,
      '**/api/v1/auth/mfa-challenges/*/session',
      400,
      errorBody('INVALID_MFA_CODE'),
    );

    await mfa.navigate('ch-e2e', SCHOOL.semel);
    await mfa.verify(ID_NUMBER, '000000', GOOD_PASSWORD);

    await expect(mfa.errorMessage).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/mfa\?/);
    await expect(mfa.codeInput).toHaveValue('000000');
  });

  test('a bare /auth/mfa renders a start-again state', async ({ page }) => {
    const mfa = new MfaPage(page);
    await mfa.navigateWithoutChallenge();

    await expect(mfa.startAgain).toHaveAttribute('href', '/auth/sign-in');
    await expect(mfa.submitButton).toHaveCount(0);
  });
});

test.describe('captcha escape hatch', () => {
  test.beforeEach(async ({ page }) => {
    await routeSchools(page);
  });

  test('appears only when Mashov demands a captcha', async ({ page }) => {
    // Mashov's Turnstile site key is domain-locked (Cloudflare 110200 on our
    // origin), so we cannot solve the challenge for them. This single link is
    // the fallback, and it must not show in any other state.
    const auth = new AuthPage(page);
    await routeJson(page, '**/api/v1/auth/login', 400, errorBody('CAPTCHA_REQUIRED'));

    await auth.signIn(SCHOOL.name, SCHOOL.semel, ID_NUMBER, GOOD_PASSWORD);

    await expect(page.getByTestId('sign-in-captcha-escape-link')).toHaveAttribute(
      'href',
      'https://web.mashov.info/students/login',
    );
  });

  test('stays hidden for an ordinary wrong password', async ({ page }) => {
    const auth = new AuthPage(page);
    await routeJson(page, '**/api/v1/auth/login', 401, errorBody('INVALID_CREDENTIALS'));

    await auth.signIn(SCHOOL.name, SCHOOL.semel, ID_NUMBER, 'wrongpw1');

    await expect(auth.errorMessage).toBeVisible();
    await expect(page.getByTestId('sign-in-captcha-escape')).toHaveCount(0);
    // And the 401 with INVALID_CREDENTIALS did NOT bounce us off the page.
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });
});
