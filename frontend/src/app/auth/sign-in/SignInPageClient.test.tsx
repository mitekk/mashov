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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const getSchools = vi.fn();
const login = vi.fn();
const requestOtp = vi.fn();
const createOtpSession = vi.fn();
vi.mock('@/api/auth', () => ({
  getSchools: (...args: unknown[]) => getSchools(...args),
  login: (...args: unknown[]) => login(...args),
  requestOtp: (...args: unknown[]) => requestOtp(...args),
  createOtpSession: (...args: unknown[]) => createOtpSession(...args),
}));

const SCHOOL = { semel: 482273, name: 'תיכון הרצוג', years: [2027] };

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SignInPageClient />
    </QueryClientProvider>,
  );
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
  requestOtp.mockResolvedValue({ otpRequestId: 'otp-1', method: 'email' });
  createOtpSession.mockResolvedValue({ ok: true, isFirstLogin: false });
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
      expect(push).toHaveBeenCalledWith(
        `/auth/mfa?cid=ch-9&semel=${SCHOOL.semel}&username=303977367`,
      );
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
        `/auth/complete-setup?mode=password&semel=${SCHOOL.semel}&username=303977367`,
      );
    });
  });

  it('routes a credentials setup to the setup screen in credentials mode', async () => {
    rejectWith(400, 'CREDENTIALS_SETUP_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/auth/complete-setup?mode=credentials&semel=${SCHOOL.semel}&username=303977367`,
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

describe('SignInPageClient passwordless sign-in', () => {
  it('hides the password field when a passwordless method is chosen', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-email'));

    expect(screen.queryByTestId('sign-in-password')).toBeNull();
    expect(screen.getByTestId('sign-in-request-code')).toBeInTheDocument();
  });

  it('asks for a code on the chosen channel', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-sms'));

    const picker = await screen.findByTestId('sign-in-school-selector');
    fireEvent.focus(picker);
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.change(screen.getByTestId('sign-in-username'), {
      target: { value: '303977367' },
    });
    fireEvent.click(screen.getByTestId('sign-in-request-code'));

    await waitFor(() => {
      expect(requestOtp.mock.calls[0][0]).toEqual({
        semel: SCHOOL.semel,
        username: '303977367',
        method: 'sms',
      });
    });
  });

  it('exchanges the code for a session', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-email'));
    fireEvent.focus(await screen.findByTestId('sign-in-school-selector'));
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.change(screen.getByTestId('sign-in-username'), {
      target: { value: '303977367' },
    });
    fireEvent.click(screen.getByTestId('sign-in-request-code'));

    const codeInput = await screen.findByTestId('sign-in-otp-code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('sign-in-submit'));

    await waitFor(() => {
      expect(createOtpSession.mock.calls[0][0]).toBe('otp-1');
      expect(createOtpSession.mock.calls[0][1]).toEqual({ code: '123456' });
    });
  });

  it('explains that a first sign-in needs a password, rather than hiding it', async () => {
    // The constraint is real: background sync decrypts a stored password, so an
    // OTP-only household would see data that never updates.
    requestOtp.mockRejectedValue(
      new ApiError(409, 'nope', {
        error: { code: 'PASSWORD_SIGN_IN_REQUIRED', message: 'nope', details: [] },
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-email'));
    fireEvent.focus(await screen.findByTestId('sign-in-school-selector'));
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.change(screen.getByTestId('sign-in-username'), {
      target: { value: '303977367' },
    });
    fireEvent.click(screen.getByTestId('sign-in-request-code'));

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error').textContent).toContain(
        'הכניסה הראשונה',
      );
    });
    expect(screen.queryByTestId('sign-in-otp-code')).toBeNull();
  });

  it('warns that passwordless sign-in does not keep data updating', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-email'));

    const note = await screen.findByTestId('sign-in-passwordless-note');
    expect(note.textContent).toMatch(/[֐-׿]/);
  });

  it('wires the OTP code input for autofill and LTR digits', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('sign-in-method-email'));
    fireEvent.focus(await screen.findByTestId('sign-in-school-selector'));
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.change(screen.getByTestId('sign-in-username'), {
      target: { value: '303977367' },
    });
    fireEvent.click(screen.getByTestId('sign-in-request-code'));

    const code = await screen.findByTestId('sign-in-otp-code');
    expect(code).toHaveAttribute('dir', 'ltr');
    expect(code).toHaveAttribute('inputMode', 'numeric');
    expect(code).toHaveAttribute('autoComplete', 'one-time-code');
  });
});
