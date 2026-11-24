import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import ResetPasswordPageClient from './ResetPasswordPageClient';

const push = vi.fn();
let searchParams = new URLSearchParams('rid=rid-1&semel=482273');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const completeRecovery = vi.fn();
const login = vi.fn();
vi.mock('@/api/auth', () => ({
  completeRecovery: (...args: unknown[]) => completeRecovery(...args),
  login: (...args: unknown[]) => login(...args),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ResetPasswordPageClient />
    </QueryClientProvider>,
  );
}

function fill({ code = 'ABC123', password = 'secret1' } = {}) {
  fireEvent.change(screen.getByTestId('reset-password-code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByTestId('reset-password-new-password'), {
    target: { value: password },
  });
}

function apiError(status: number, code: string) {
  return new ApiError(status, 'msg', {
    error: { code, message: 'msg', details: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams('rid=rid-1&semel=482273');
  completeRecovery.mockResolvedValue({ ok: true, username: '303977367' });
  login.mockResolvedValue({ ok: true, isFirstLogin: false });
});

describe('ResetPasswordPageClient', () => {
  /**
   * The second unrecoverable trap on this screen.
   *
   * A second step-1 request invalidates the first code UPSTREAM, while this
   * page still carries the older `rid` in its URL. A parent who did not see the
   * first email, asked again, and then typed the newer code into the older
   * page's form gets "that code is not valid" for a code that is genuinely
   * live — and no error message can explain it, because by then the handle is
   * the wrong one.
   *
   * The only place to say it is before the mistake.
   */
  it('warns that asking for a new code voids the previous one', () => {
    renderPage();
    const note = screen.getByTestId('reset-password-code-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/קוד חדש/);
  });

  it('posts the code and the new password against the recovery id', async () => {
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    await waitFor(() => {
      expect(completeRecovery.mock.calls[0][0]).toBe('rid-1');
      expect(completeRecovery.mock.calls[0][1]).toMatchObject({
        code: 'ABC123',
        newPassword: 'secret1',
      });
    });
  });

  it('tells the parent to start again when there is no recovery id', async () => {
    // A bare /auth/reset-password, or a stale bookmark. Rendering the form
    // would collect a code the server cannot match to anything.
    searchParams = new URLSearchParams('');
    renderPage();

    expect(await screen.findByTestId('reset-password-start-again')).toHaveAttribute(
      'href',
      '/auth/forgot-password',
    );
    expect(screen.queryByTestId('reset-password-submit')).toBeNull();
  });

  it('shows a live checklist, so the parent cannot reach the unhelpable 404', async () => {
    // Mashov answers 404 for a policy violation exactly as for a bad code, and
    // the code is single-use. The checklist is what stops the parent getting
    // there at all.
    renderPage();
    const checklist = await screen.findByTestId('reset-password-policy-checklist');
    expect(checklist).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('reset-password-new-password'), {
      target: { value: 'abc' },
    });
    expect(screen.getByTestId('reset-password-rule-minLength')).toHaveAttribute(
      'data-satisfied',
      'false',
    );
    expect(screen.getByTestId('reset-password-rule-letter')).toHaveAttribute(
      'data-satisfied',
      'true',
    );

    fireEvent.change(screen.getByTestId('reset-password-new-password'), {
      target: { value: 'abcde1' },
    });
    expect(screen.getByTestId('reset-password-rule-minLength')).toHaveAttribute(
      'data-satisfied',
      'true',
    );
    expect(screen.getByTestId('reset-password-rule-digit')).toHaveAttribute(
      'data-satisfied',
      'true',
    );
  });

  it('refuses to submit a password that breaks the policy', async () => {
    renderPage();
    fill({ password: 'abc' });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-error')).toBeInTheDocument();
    expect(completeRecovery).not.toHaveBeenCalled();
  });

  it('refuses to submit without a code', async () => {
    renderPage();
    fill({ code: '  ' });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-error')).toBeInTheDocument();
    expect(completeRecovery).not.toHaveBeenCalled();
  });

  it('shows a second code field only when the server asked for one', async () => {
    renderPage();
    expect(screen.queryByTestId('reset-password-second-code')).toBeNull();

    completeRecovery.mockRejectedValue(apiError(400, 'SECOND_CODE_REQUIRED'));
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-second-code')).toBeInTheDocument();
  });

  it('sends both codes once the second field is showing', async () => {
    completeRecovery.mockRejectedValueOnce(apiError(400, 'SECOND_CODE_REQUIRED'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const second = await screen.findByTestId('reset-password-second-code');
    completeRecovery.mockResolvedValue({ ok: true, username: '303977367' });
    fireEvent.change(second, { target: { value: 'DEF456' } });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    await waitFor(() => {
      expect(completeRecovery.mock.calls[1][1]).toMatchObject({
        code: 'ABC123',
        secondCode: 'DEF456',
      });
    });
  });

  it('auto signs in with the new password it still holds in memory', async () => {
    // The server deliberately mints no session: whoever completed recovery
    // proved control of the school's contact details, not ownership of our
    // household. Chaining into the normal login keeps the boundary intact and
    // the experience the same.
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    await waitFor(() => {
      expect(login.mock.calls[0][0]).toEqual({
        semel: 482273,
        username: '303977367',
        password: 'secret1',
      });
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it('confirms the reset and names the username', async () => {
    login.mockRejectedValue(new Error('whatever'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const done = await screen.findByTestId('reset-password-success');
    expect(done.textContent).toContain('הסיסמה עודכנה במשוב');
    expect(screen.getByTestId('reset-password-username').textContent).toContain(
      '303977367',
    );
  });

  it('falls back to a sign-in link when the auto sign-in fails', async () => {
    login.mockRejectedValue(new Error('whatever'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-go-to-sign-in')).toHaveAttribute(
      'href',
      '/auth/sign-in',
    );
  });

  it('distinguishes an outage from a wrong code', async () => {
    // The parent has already burned a single-use code. Telling them it was
    // wrong when the network failed is unrecoverable.
    completeRecovery.mockRejectedValue(apiError(502, 'UPSTREAM_ERROR'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const error = await screen.findByTestId('reset-password-error');
    expect(error.textContent).toContain('משוב אינו זמין כרגע');
  });

  it('offers a fresh start when the recovery handle has expired', async () => {
    completeRecovery.mockRejectedValue(apiError(400, 'RECOVERY_SESSION_EXPIRED'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-start-again')).toHaveAttribute(
      'href',
      '/auth/forgot-password',
    );
  });

  it('wires the code input for iOS SMS autofill and LTR digits', async () => {
    renderPage();
    const code = screen.getByTestId('reset-password-code');
    expect(code).toHaveAttribute('dir', 'ltr');
    expect(code).toHaveAttribute('inputMode', 'numeric');
    expect(code).toHaveAttribute('autoComplete', 'one-time-code');
  });

  it('marks the password field as a new password', async () => {
    renderPage();
    const password = screen.getByTestId('reset-password-new-password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'new-password');
  });
});

describe('ResetPasswordPageClient review fixes', () => {
  it('names the rule the server rejected, not just "does not meet the policy"', async () => {
    // The checklist deliberately hides the `noUsername` rule, because the
    // username is unknown on this screen. The backend still enforces it against
    // the recovering ID number -- so without rendering `details[]` the parent
    // sees an all-green checklist and a generic rejection, with nothing to act
    // on. The envelope already carries the Hebrew message.
    completeRecovery.mockRejectedValue(
      new ApiError(422, 'weak', {
        error: {
          code: 'WEAK_PASSWORD',
          message: 'weak',
          details: [
            { field: 'newPassword', message: 'הסיסמה לא יכולה להכיל את שם המשתמש' },
          ],
        },
      }),
    );
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const error = await screen.findByTestId('reset-password-error');
    expect(error.textContent).toContain('הסיסמה לא יכולה להכיל את שם המשתמש');
  });

  it('lists every rule the server rejected', async () => {
    completeRecovery.mockRejectedValue(
      new ApiError(422, 'weak', {
        error: {
          code: 'WEAK_PASSWORD',
          message: 'weak',
          details: [
            { field: 'newPassword', message: 'לפחות 6 תווים' },
            { field: 'newPassword', message: 'לפחות ספרה אחת' },
          ],
        },
      }),
    );
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const error = await screen.findByTestId('reset-password-error');
    expect(error.textContent).toContain('לפחות 6 תווים');
    expect(error.textContent).toContain('לפחות ספרה אחת');
  });

  it('falls back to the code\u2019s own copy when there are no details', async () => {
    completeRecovery.mockRejectedValue(apiError(400, 'INVALID_RECOVERY_CODE'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect((await screen.findByTestId('reset-password-error')).textContent).toContain(
      'קוד האימות שגוי',
    );
  });
});

describe('ResetPasswordPageClient minor fixes', () => {
  it('renders both code fields up front when the handle says two are needed', async () => {
    searchParams = new URLSearchParams('rid=rid-1&semel=482273&two=1');
    renderPage();

    expect(await screen.findByTestId('reset-password-code')).toBeInTheDocument();
    expect(screen.getByTestId('reset-password-second-code')).toBeInTheDocument();
  });

  it('sends both codes on the first submit, with no wasted round trip', async () => {
    searchParams = new URLSearchParams('rid=rid-1&semel=482273&two=1');
    renderPage();

    fireEvent.change(screen.getByTestId('reset-password-code'), {
      target: { value: 'AAA111' },
    });
    fireEvent.change(screen.getByTestId('reset-password-second-code'), {
      target: { value: 'BBB222' },
    });
    fireEvent.change(screen.getByTestId('reset-password-new-password'), {
      target: { value: 'secret1' },
    });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    await waitFor(() => {
      expect(completeRecovery.mock.calls[0][1]).toMatchObject({
        code: 'AAA111',
        secondCode: 'BBB222',
      });
    });
  });

  it('demands the second code before submitting when it knows one is needed', async () => {
    searchParams = new URLSearchParams('rid=rid-1&semel=482273&two=1');
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-error')).toBeInTheDocument();
    expect(completeRecovery).not.toHaveBeenCalled();
  });

  it('still obeys the server when the hint is absent or lies', async () => {
    // The hint is a convenience. The SERVER-stored flag remains the authority:
    // a client that dropped `two=1` still gets SECOND_CODE_REQUIRED and the
    // field appears then.
    searchParams = new URLSearchParams('rid=rid-1&semel=482273');
    completeRecovery.mockRejectedValue(apiError(400, 'SECOND_CODE_REQUIRED'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-second-code')).toBeInTheDocument();
  });

  // M18 — a lockout and an expiry are the same situation for the parent.
  it('offers a fresh start when the attempts are used up', async () => {
    // The server deletes the handle on the 6th attempt, so the NEXT call would
    // answer RECOVERY_SESSION_EXPIRED anyway. Showing an error the parent
    // cannot act on, and only then the start-again panel, is two screens for
    // one dead end.
    completeRecovery.mockRejectedValue(apiError(429, 'RECOVERY_LOCKED'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    expect(await screen.findByTestId('reset-password-start-again')).toHaveAttribute(
      'href',
      '/auth/forgot-password',
    );
  });
});
