// Imported here rather than in a global setup file: the repo has no vitest
// setup file, and `@testing-library/jest-dom` is a declared dependency no test
// had reached for yet.
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { AUTH_ERROR_COPY } from '@/lib/authErrors';
import SignInPageClient from './SignInPageClient';

const push = vi.fn();
const replace = vi.fn();
// Parameterised so a test can supply `?next=...`. Reset to '' in `beforeEach`,
// which is what keeps every pre-existing test on its original no-`next` path.
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const getSchools = vi.fn();
const login = vi.fn();
const getMeOrNull = vi.fn();
// The factory is partial, so an export missing from it imports as `undefined`
// and throws inside the queryFn. `getMeOrNull` has to be listed here.
vi.mock('@/api/auth', () => ({
  getSchools: (...args: unknown[]) => getSchools(...args),
  login: (...args: unknown[]) => login(...args),
  getMeOrNull: (...args: unknown[]) => getMeOrNull(...args),
}));

const SCHOOL = { semel: 482273, name: 'תיכון הרצוג', years: [2027] };

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SignInPageClient />
      </QueryClientProvider>,
    ),
  };
}

async function submitSignIn() {
  const picker = await screen.findByTestId('sign-in-school-selector');
  fireEvent.focus(picker);
  fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
  fireEvent.change(screen.getByTestId('sign-in-username'), {
    target: { value: '303977367' },
  });
  fireEvent.change(screen.getByTestId('sign-in-password'), {
    target: { value: 'secret1' },
  });
  fireEvent.click(screen.getByTestId('sign-in-submit'));
}

function rejectWith(status: number, code: string, extra: Record<string, unknown> = {}) {
  login.mockRejectedValue(
    new ApiError(status, 'upstream message', {
      error: { code, message: 'upstream message', details: [], ...extra },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSchools.mockResolvedValue([SCHOOL]);
  getMeOrNull.mockResolvedValue(null);
  nav.search = '';
  localStorage.clear();
});

describe('SignInPageClient', () => {
  it('offers a way out for a parent who has forgotten their password', async () => {
    renderPage();

    const link = await screen.findByTestId('sign-in-forgot-password');
    expect(link).toHaveAttribute('href', '/auth/forgot-password');
  });

  it('does not blame the password when Mashov wants it changed', async () => {
    // The whole point of the Reason classifier: this used to render "wrong
    // credentials" and send the parent off to retype a correct password.
    //
    // It no longer renders the message either -- there is now a screen that
    // FIXES it, so the form routes there instead. The copy is still asserted,
    // in `authErrors.test.ts`, for the clients that only show it.
    rejectWith(400, 'PASSWORD_CHANGE_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        expect.stringContaining('/auth/complete-setup'),
      );
    });
    expect(screen.queryByTestId('sign-in-error')).toBeNull();
  });

  it('names the missing-children case instead of blaming the password', async () => {
    rejectWith(400, 'NO_CHILDREN');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toHaveTextContent(
        AUTH_ERROR_COPY.NO_CHILDREN,
      );
    });
  });

  it('still says "wrong credentials" when the credentials really are wrong', async () => {
    rejectWith(401, 'INVALID_CREDENTIALS');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toHaveTextContent(
        AUTH_ERROR_COPY.INVALID_CREDENTIALS,
      );
    });
  });

  it('sends an MFA challenge straight to the code screen, carrying the challenge id', async () => {
    rejectWith(400, 'MFA_REQUIRED', { challengeId: 'ch-9' });
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/auth/mfa?cid=ch-9&semel=${SCHOOL.semel}`);
    });
  });

  it('shows the MFA message rather than navigating when there is no challenge id', async () => {
    // Without a challenge id the next screen has nothing to work with, so
    // navigating there would be a dead end with a spinner.
    rejectWith(400, 'MFA_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toHaveTextContent(
        AUTH_ERROR_COPY.MFA_REQUIRED,
      );
    });
    expect(push).not.toHaveBeenCalled();
  });
});

describe('SignInPageClient forced credential change', () => {
  it('routes a forced password change to the setup screen', async () => {
    rejectWith(400, 'PASSWORD_CHANGE_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/auth/complete-setup?mode=password&semel=${SCHOOL.semel}`,
      );
    });
  });

  it('routes a credentials setup to the setup screen in credentials mode', async () => {
    rejectWith(400, 'CREDENTIALS_SETUP_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/auth/complete-setup?mode=credentials&semel=${SCHOOL.semel}`,
      );
    });
  });

  it('carries a challenge id through when Mashov sent one', async () => {
    rejectWith(400, 'PASSWORD_CHANGE_REQUIRED', { challengeId: 'ch-4' });
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(String(push.mock.calls[0][0])).toContain('cid=ch-4');
    });
  });
});


describe('SignInPageClient captcha escape hatch', () => {
  it('offers the Mashov link only when Mashov demands a captcha', async () => {
    // Mashov's Turnstile site key is domain-locked (Cloudflare error 110200 on
    // our origin), so we cannot solve the challenge for them. A single
    // escape-hatch link is the fallback; the point of this test is that it
    // appears HERE and nowhere else.
    rejectWith(400, 'CAPTCHA_REQUIRED');
    renderPage();
    await submitSignIn();

    const link = await screen.findByTestId('sign-in-captcha-escape-link');
    expect(link).toHaveAttribute('href', 'https://web.mashov.info/students/login');
  });

  it('shows no Mashov link in the happy path', async () => {
    login.mockResolvedValue({ ok: true, isFirstLogin: false });
    renderPage();
    await submitSignIn();

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(screen.queryByTestId('sign-in-captcha-escape')).toBeNull();
  });

  it('shows no Mashov link for an ordinary wrong password', async () => {
    rejectWith(401, 'INVALID_CREDENTIALS');
    renderPage();
    await submitSignIn();

    await waitFor(() => expect(screen.getByTestId('sign-in-error')).toBeInTheDocument());
    expect(screen.queryByTestId('sign-in-captcha-escape')).toBeNull();
  });

  it('is the only place in the app that points at web.mashov.info', async () => {
    // The never-navigate-away goal, asserted rather than hoped for: the string
    // may appear in exactly one component.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const root = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const text = await fs.readFile(full, 'utf8');
        if (text.includes('web.mashov.info')) {
          offenders.push(path.relative(root, full));
        }
      }
    }

    await walk(root);

    expect(offenders).toEqual(['components/auth/CaptchaEscapeHatch.tsx']);
  });
});

describe('SignInPageClient review fixes', () => {
  it('keeps the username out of the MFA URL', async () => {
    // For these accounts the Mashov username IS the national ID number, so a
    // query string puts it in browser history and in every reverse-proxy
    // access log. The next screen asks for it, like it already asks for the
    // password.
    rejectWith(400, 'MFA_REQUIRED', { challengeId: 'ch-9' });
    renderPage();
    await submitSignIn();

    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = String(push.mock.calls[0][0]);
    expect(url).toContain('cid=ch-9');
    expect(url).not.toContain('303977367');
    expect(url).not.toContain('username');
  });

  it('keeps the username out of the forced-change URL', async () => {
    rejectWith(400, 'PASSWORD_CHANGE_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = String(push.mock.calls[0][0]);
    expect(url).toContain('/auth/complete-setup');
    expect(url).not.toContain('303977367');
    expect(url).not.toContain('username');
  });
});

describe('SignInPageClient page chrome', () => {
  it('renders the illustration outside the form, so it can be server-rendered', async () => {
    // The structural reason for the SignInForm/SignInPage split, pinned.
    // `SignInForm` calls `useSearchParams()`, which makes its Suspense boundary
    // bail out of SSR -- so an <Image priority> inside it emits no
    // <link rel="preload"> and waits for hydration, which is the whole point
    // of `priority` gone. Someone folding the chrome back into the form to
    // "simplify" it would undo a measured optimisation with no test to notice.
    renderPage();

    const illustration = await screen.findByTestId('sign-in-illustration');
    const form = screen.getByTestId('sign-in-submit').closest('form');

    expect(illustration).toBeInTheDocument();
    expect(form).not.toBeNull();
    expect(form?.contains(illustration)).toBe(false);
  });

  it('keeps the illustration decorative, not announced before the form', async () => {
    renderPage();

    const illustration = await screen.findByTestId('sign-in-illustration');
    expect(illustration).toHaveAttribute('alt', '');
  });

  it('still renders the whole page from the default export', async () => {
    // The merge moved the chrome from SignInForm to SignInPage; the default
    // export has to keep being the thing that renders both.
    renderPage();

    expect(await screen.findByTestId('sign-in-illustration')).toBeInTheDocument();
    expect(screen.getByTestId('sign-in-submit')).toBeInTheDocument();
    expect(screen.getByTestId('sign-in-forgot-password')).toBeInTheDocument();
  });
});

/**
 * The flag, and why it is not merely cosmetic.
 *
 * Passwordless sign-in is refused by Mashov on both channels today -- the
 * upstream contract was read out of its Angular bundle, never observed -- so a
 * parent who picked "קוד לאימייל" was told their code was invalid before they
 * had been sent one. Until a real capture proves the contract, the methods are
 * not offered. Without these two tests the flag has no cover and a refactor
 * silently re-enables the dead end.
 */
/**
 * Passwordless sign-in was removed, not disabled.
 *
 * Mashov gates `POST /api/user/otp/request` behind a Cloudflare Turnstile
 * token, which a server-side client cannot mint -- and the second half of the
 * flow we had built did not exist at all: the one-time code goes in the
 * `password` field of an ordinary `POST /api/login`. Captured 2026-11-24.
 *
 * This describe is the guard against someone re-adding a method picker on the
 * strength of the Hebrew copy or an old ADR.
 */
describe('SignInPageClient has no passwordless sign-in', () => {
  it('offers no one-time-code methods at all', async () => {
    renderPage();
    await screen.findByTestId('sign-in-school-selector');

    expect(screen.queryByTestId('sign-in-method-email')).toBeNull();
    expect(screen.queryByTestId('sign-in-method-sms')).toBeNull();
    expect(screen.queryByTestId('sign-in-method-password')).toBeNull();
    expect(screen.queryByTestId('sign-in-request-code')).toBeNull();
  });

  it('signs in with a password, which is the only method Mashov lets us use', async () => {
    renderPage();
    fireEvent.focus(await screen.findByTestId('sign-in-school-selector'));
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.change(screen.getByTestId('sign-in-username'), {
      target: { value: '303977367' },
    });
    fireEvent.change(screen.getByTestId('sign-in-password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(screen.getByTestId('sign-in-submit'));

    await waitFor(() => expect(login).toHaveBeenCalled());
  });
});


/**
 * Skipping sign-in when a session already exists.
 *
 * Telegram deep links point at /home, and a browser that does not send the
 * cookie on that first hop is bounced here by middleware with `?next=/home` --
 * so a signed-in parent was being asked to retype credentials they did not
 * need. These tests pin the bounce, the gate that keeps it off every other
 * path to this page, and the open redirect that the bounce would otherwise
 * make reachable before authentication.
 */
describe('SignInPageClient existing-session bounce', () => {
  const MOCK_USER = {
    mashovUserId: 'u-1',
    username: 'parent',
    displayName: 'Parent',
    schools: [],
    childrenCount: 2,
  };

  it('renders the form when the probe says there is no session', async () => {
    nav.search = 'next=%2Fhome';
    getMeOrNull.mockResolvedValue(null);
    renderPage();

    expect(await screen.findByTestId('sign-in-submit')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('goes straight to next, without showing the form, when a session exists', async () => {
    nav.search = 'next=%2Fhome';
    getMeOrNull.mockResolvedValue(MOCK_USER);
    renderPage();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/home'));
    expect(screen.queryByTestId('sign-in-submit')).toBeNull();
    // Reused, not re-created: `useQuery` does not suspend, so the Suspense
    // fallback does not re-show for the probe and the form would otherwise
    // flash at its own height.
    expect(screen.getByTestId('sign-in-loading')).toBeInTheDocument();
  });

  it('refuses to bounce off-site, which is now reachable before authentication', async () => {
    nav.search = 'next=https%3A%2F%2Fevil.com';
    getMeOrNull.mockResolvedValue(MOCK_USER);
    renderPage();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(String(replace.mock.calls[0][0])).not.toContain('evil.com');
  });

  it('shows the form when the probe fails outright', async () => {
    // A network failure or the 4s timeout. There is no path to a stuck
    // spinner.
    nav.search = 'next=%2Fhome';
    getMeOrNull.mockRejectedValue(new Error('network down'));
    renderPage();

    expect(await screen.findByTestId('sign-in-submit')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not probe at all when there is no next', async () => {
    // The gate, pinned. `next` is set ONLY by middleware; every in-app
    // navigation here -- sign-out included -- arrives bare. A sign-out whose
    // DELETE failed must not be read as a live session and bounced back into
    // the app.
    nav.search = '';
    getMeOrNull.mockResolvedValue(MOCK_USER);
    renderPage();

    expect(await screen.findByTestId('sign-in-submit')).toBeInTheDocument();
    expect(getMeOrNull).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('seeds the user cache so the destination renders without a refetch', async () => {
    nav.search = 'next=%2Fhome';
    getMeOrNull.mockResolvedValue(MOCK_USER);
    const { client } = renderPage();

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(client.getQueryData(['me'])).toEqual(MOCK_USER);
  });

  it('never writes a null user into the key four pages read', async () => {
    // `useMe` is typed `AppUser`; a null there is `status: 'success'` with
    // `data === null`, which consumers would read as a valid user.
    nav.search = 'next=%2Fhome';
    getMeOrNull.mockResolvedValue(null);
    const { client } = renderPage();

    await screen.findByTestId('sign-in-submit');
    expect(client.getQueryData(['me'])).toBeUndefined();
  });

  it('does not push an off-site next after a successful login either', async () => {
    // The pre-existing open redirect: `router.push` took `next` verbatim, and
    // only `/auth*` was filtered.
    nav.search = 'next=%2F%2Fevil.com';
    getMeOrNull.mockResolvedValue(null);
    login.mockResolvedValue({ ok: true, isFirstLogin: false });
    renderPage();
    await submitSignIn();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });
});
