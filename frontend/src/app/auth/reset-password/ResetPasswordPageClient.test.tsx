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
