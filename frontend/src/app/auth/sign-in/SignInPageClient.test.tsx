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
vi.mock('@/api/auth', () => ({
  getSchools: (...args: unknown[]) => getSchools(...args),
  login: (...args: unknown[]) => login(...args),
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
  localStorage.clear();
});

describe('SignInPageClient', () => {
  it('offers a way out for a parent who has forgotten their password', async () => {
    renderPage();

    const link = await screen.findByTestId('sign-in-forgot-password');
    expect(link).toHaveAttribute('href', '/auth/forgot-password');
  });

  it('tells a parent whose password is correct that Mashov wants it changed', async () => {
    // The whole point of the Reason classifier: this used to render "wrong
    // credentials" and send the parent off to retype a correct password.
    rejectWith(400, 'PASSWORD_CHANGE_REQUIRED');
    renderPage();
    await submitSignIn();

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toHaveTextContent(
        AUTH_ERROR_COPY.PASSWORD_CHANGE_REQUIRED,
      );
    });
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
