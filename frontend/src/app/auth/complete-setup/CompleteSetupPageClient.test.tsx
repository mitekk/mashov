import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import CompleteSetupPageClient from './CompleteSetupPageClient';

const push = vi.fn();
let searchParams = new URLSearchParams('semel=482273&mode=password');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const setCredentials = vi.fn();
vi.mock('@/api/auth', () => ({
  setCredentials: (...args: unknown[]) => setCredentials(...args),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CompleteSetupPageClient />
    </QueryClientProvider>,
  );
}

function fill({
  current = 'oldpw1',
  next = 'secret1',
  username,
  accountUsername = '303977367',
}: {
  current?: string;
  next?: string;
  username?: string;
  accountUsername?: string | null;
} = {}) {
  if (accountUsername !== null) {
    fireEvent.change(screen.getByTestId('complete-setup-username'), {
      target: { value: accountUsername },
    });
  }
  fireEvent.change(screen.getByTestId('complete-setup-current-password'), {
    target: { value: current },
  });
  fireEvent.change(screen.getByTestId('complete-setup-new-password'), {
    target: { value: next },
  });
  if (username !== undefined) {
    fireEvent.change(screen.getByTestId('complete-setup-new-username'), {
      target: { value: username },
    });
  }
}

function apiError(status: number, code: string) {
  return new ApiError(status, 'msg', {
    error: { code, message: 'msg', details: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams('semel=482273&mode=password');
  setCredentials.mockResolvedValue({ ok: true, isFirstLogin: false });
});

describe('CompleteSetupPageClient', () => {
  it('posts the current and new password for a forced password change', async () => {
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => {
      expect(setCredentials.mock.calls[0][0]).toEqual({
        semel: 482273,
        username: '303977367',
        password: 'oldpw1',
        newPassword: 'secret1',
      });
    });
  });

  it('echoes a challenge id through when Mashov sent one', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=password&cid=ch-3');
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => {
      expect(setCredentials.mock.calls[0][0]).toMatchObject({ challengeId: 'ch-3' });
    });
  });

  it('asks for a username too in credentials-setup mode', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=credentials');
    renderPage();

    expect(await screen.findByTestId('complete-setup-new-username')).toBeInTheDocument();
  });

  it('does not ask for a username in password-only mode', async () => {
    renderPage();
    expect(screen.queryByTestId('complete-setup-new-username')).toBeNull();
  });

  it('sends the new username alongside the new password', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=credentials');
    renderPage();
    fill({ username: 'avocado' });
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => {
      expect(setCredentials.mock.calls[0][0]).toMatchObject({
        newUsername: 'avocado',
        newPassword: 'secret1',
      });
    });
  });

  it('shows the live policy checklist', async () => {
    renderPage();
    expect(
      await screen.findByTestId('complete-setup-policy-checklist'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('complete-setup-new-password'), {
      target: { value: 'abcdef' },
    });
    expect(screen.getByTestId('complete-setup-rule-digit')).toHaveAttribute(
      'data-satisfied',
      'false',
    );
  });

  it('checks the new password against the username the parent typed', async () => {
    // Unlike the recovery screen, the username is known here -- now because
    // the parent entered it rather than because it rode in the URL -- so the
    // relational rule can be live too.
    renderPage();
    fireEvent.change(screen.getByTestId('complete-setup-username'), {
      target: { value: '303977367' },
    });
    fireEvent.change(screen.getByTestId('complete-setup-new-password'), {
      target: { value: 'a1303977367' },
    });
    expect(screen.getByTestId('complete-setup-rule-noUsername')).toHaveAttribute(
      'data-satisfied',
      'false',
    );
  });

  it('refuses to submit a policy-breaking password', async () => {
    renderPage();
    fill({ next: 'abc' });
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    expect(await screen.findByTestId('complete-setup-error')).toBeInTheDocument();
    expect(setCredentials).not.toHaveBeenCalled();
  });

  it('lands in the app on success', async () => {
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('sends a first login to the sync screen', async () => {
    setCredentials.mockResolvedValue({ ok: true, isFirstLogin: true });
    renderPage();
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/auth/syncing'));
  });

  it('names a taken username rather than blaming the password', async () => {
    setCredentials.mockRejectedValue(apiError(409, 'USERNAME_TAKEN'));
    searchParams = new URLSearchParams('semel=482273&mode=credentials');
    renderPage();
    fill({ username: 'avocado' });
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    const error = await screen.findByTestId('complete-setup-error');
    expect(error.textContent).toMatch(/[֐-׿]/);
  });

  it('tells the parent to start again with no school in the URL', async () => {
    searchParams = new URLSearchParams('');
    renderPage();

    expect(await screen.findByTestId('complete-setup-start-again')).toHaveAttribute(
      'href',
      '/auth/sign-in',
    );
    expect(screen.queryByTestId('complete-setup-submit')).toBeNull();
  });
});

describe('CompleteSetupPageClient review fixes', () => {
  it('asks for the username, because it is no longer in the URL', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=password');
    renderPage();

    const field = await screen.findByTestId('complete-setup-username');
    fireEvent.change(field, { target: { value: '303977367' } });
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => {
      expect(setCredentials.mock.calls[0][0]).toMatchObject({
        username: '303977367',
      });
    });
  });

  it('refuses to submit with no username', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=password');
    renderPage();
    // `accountUsername: null` leaves the field untouched; the helper fills it
    // by default, because every other test needs it filled.
    fill({ accountUsername: null });
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    expect(await screen.findByTestId('complete-setup-error')).toBeInTheDocument();
    expect(setCredentials).not.toHaveBeenCalled();
  });

  it('routes an MFA demand onward with the challenge id it was given', async () => {
    searchParams = new URLSearchParams('semel=482273&mode=password');
    setCredentials.mockRejectedValue(
      new ApiError(400, 'mfa', {
        error: {
          code: 'MFA_REQUIRED',
          message: 'mfa',
          details: [],
          challengeId: 'ch-11',
        },
      }),
    );
    renderPage();
    fireEvent.change(await screen.findByTestId('complete-setup-username'), {
      target: { value: '303977367' },
    });
    fill();
    fireEvent.click(screen.getByTestId('complete-setup-submit'));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        expect.stringContaining('/auth/mfa?cid=ch-11'),
      );
    });
  });
});
