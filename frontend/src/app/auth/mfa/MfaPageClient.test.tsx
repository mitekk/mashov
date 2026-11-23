import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import MfaPageClient from './MfaPageClient';

const push = vi.fn();
let searchParams = new URLSearchParams('cid=ch-1&semel=482273&username=303977367');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const sendMfaCode = vi.fn();
const createMfaSession = vi.fn();
vi.mock('@/api/auth', () => ({
  sendMfaCode: (...args: unknown[]) => sendMfaCode(...args),
  createMfaSession: (...args: unknown[]) => createMfaSession(...args),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MfaPageClient />
    </QueryClientProvider>,
  );
}

function fill({ code = '123456', password = 'secret1' } = {}) {
  fireEvent.change(screen.getByTestId('mfa-code'), { target: { value: code } });
  fireEvent.change(screen.getByTestId('mfa-password'), { target: { value: password } });
}

function apiError(status: number, code: string) {
  return new ApiError(status, 'msg', {
    error: { code, message: 'msg', details: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams('cid=ch-1&semel=482273&username=303977367');
  sendMfaCode.mockResolvedValue({ ok: true });
  createMfaSession.mockResolvedValue({ ok: true, isFirstLogin: false });
});

describe('MfaPageClient', () => {
  it('asks Mashov to send the code on the chosen channel', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('mfa-send-sms'));

    await waitFor(() => {
      expect(sendMfaCode.mock.calls[0][0]).toBe('ch-1');
      expect(sendMfaCode.mock.calls[0][1]).toEqual({ method: 'sms' });
    });
  });

  it('completes the sign-in with the challenge, code and password', async () => {
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(createMfaSession.mock.calls[0][0]).toBe('ch-1');
      expect(createMfaSession.mock.calls[0][1]).toEqual({
        semel: 482273,
        username: '303977367',
        password: 'secret1',
        code: '123456',
      });
    });
  });

  it('asks for the password again rather than carrying it in the URL', async () => {
    // The password never travels in a query string or browser storage. Asking
    // for it once more is the cost of that, and it is the credential the sync
    // crons need stored.
    renderPage();
    expect(await screen.findByTestId('mfa-password')).toHaveAttribute(
      'type',
      'password',
    );
    expect(searchParams.toString()).not.toContain('password');
  });

  it('lands on the sync screen for a first login', async () => {
    createMfaSession.mockResolvedValue({ ok: true, isFirstLogin: true });
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/auth/syncing'));
  });

  it('lands in the app for a returning sign-in', async () => {
    createMfaSession.mockResolvedValue({ ok: true, isFirstLogin: false });
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('tells the parent to start again with no challenge id', async () => {
    searchParams = new URLSearchParams('');
    renderPage();

    expect(await screen.findByTestId('mfa-start-again')).toHaveAttribute(
      'href',
      '/auth/sign-in',
    );
    expect(screen.queryByTestId('mfa-submit')).toBeNull();
  });

  it('refuses to submit without a code', async () => {
    renderPage();
    fill({ code: '  ' });
    fireEvent.click(screen.getByTestId('mfa-submit'));

    expect(await screen.findByTestId('mfa-error')).toBeInTheDocument();
    expect(createMfaSession).not.toHaveBeenCalled();
  });

  it('refuses to submit without a password, rather than killing sync silently', async () => {
    renderPage();
    fill({ password: '' });
    fireEvent.click(screen.getByTestId('mfa-submit'));

    expect(await screen.findByTestId('mfa-error')).toBeInTheDocument();
    expect(createMfaSession).not.toHaveBeenCalled();
  });

  it('names a wrong code as a wrong code', async () => {
    createMfaSession.mockRejectedValue(apiError(400, 'INVALID_MFA_CODE'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('mfa-submit'));

    const error = await screen.findByTestId('mfa-error');
    expect(error.textContent).toMatch(/[֐-׿]/);
    expect(error.textContent).not.toMatch(/משוב אינו זמין/);
  });

  it('distinguishes an outage from a wrong code', async () => {
    createMfaSession.mockRejectedValue(apiError(502, 'UPSTREAM_ERROR'));
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('mfa-submit'));

    expect((await screen.findByTestId('mfa-error')).textContent).toContain(
      'משוב אינו זמין כרגע',
    );
  });

  it('reports a resend refusal without blaming the code', async () => {
    sendMfaCode.mockRejectedValue(apiError(429, 'MFA_RESEND_TOO_SOON'));
    renderPage();
    fireEvent.click(await screen.findByTestId('mfa-send-email'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-error').textContent).toMatch(/[֐-׿]/);
    });
  });

  it('wires the code input for iOS SMS autofill and LTR digits', async () => {
    renderPage();
    const code = await screen.findByTestId('mfa-code');
    expect(code).toHaveAttribute('dir', 'ltr');
    expect(code).toHaveAttribute('inputMode', 'numeric');
    expect(code).toHaveAttribute('autoComplete', 'one-time-code');
  });
});
