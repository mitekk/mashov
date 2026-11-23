import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import ForgotPasswordPageClient from './ForgotPasswordPageClient';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const getSchools = vi.fn();
const startRecovery = vi.fn();
vi.mock('@/api/auth', () => ({
  getSchools: (...args: unknown[]) => getSchools(...args),
  startRecovery: (...args: unknown[]) => startRecovery(...args),
}));

const SCHOOL = { semel: 482273, name: 'תיכון הרצוג', years: [2027] };

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ForgotPasswordPageClient />
    </QueryClientProvider>,
  );
}

async function submit(idNumber = '303977367') {
  fireEvent.focus(await screen.findByTestId('forgot-password-school-selector'));
  fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
  fireEvent.change(screen.getByTestId('forgot-password-id-number'), {
    target: { value: idNumber },
  });
  fireEvent.click(screen.getByTestId('forgot-password-submit'));
}

beforeEach(() => {
  vi.clearAllMocks();
  getSchools.mockResolvedValue([SCHOOL]);
  startRecovery.mockResolvedValue({
    recoveryId: 'rid-1',
    requiresSecondChannel: false,
    channel: 'email',
  });
});

describe('ForgotPasswordPageClient', () => {
  it('sends the chosen school, ID number and channel', async () => {
    renderPage();
    await submit();

    // `mock.calls[0][0]`, not `toHaveBeenCalledWith`: React Query v5 passes a
    // second context argument to every mutationFn.
    await waitFor(() => {
      expect(startRecovery.mock.calls[0][0]).toEqual({
        semel: SCHOOL.semel,
        idNumber: '303977367',
        channel: 'email',
      });
    });
  });

  it('can ask for the code by SMS instead', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('forgot-password-channel-sms'));
    await submit();

    await waitFor(() => {
      expect(startRecovery.mock.calls[0][0]).toMatchObject({ channel: 'sms' });
    });
  });

  it('hands the opaque recovery id to the reset form in the URL', async () => {
    // Opaque, single-use and server-side TTL'd, so it is safe in a URL in a way
    // a verification code is not -- and a refresh does not strand the parent.
    renderPage();
    await submit();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/auth/reset-password?rid=rid-1&semel=${SCHOOL.semel}`,
      );
    });
  });

  it('never claims a code was sent without the condition attached', async () => {
    // Enumeration-safe copy. "A code was sent to your email" would confirm the
    // ID number exists at that school, which is exactly what the
    // indistinguishable 202 on the server exists to prevent. The phrase may
    // appear, but never without `אם הפרטים נכונים` in front of it.
    renderPage();
    await submit();

    await waitFor(() => expect(push).toHaveBeenCalled());

    const body = document.body.textContent ?? '';
    if (body.includes('נשלח קוד')) {
      expect(body).toContain('אם הפרטים נכונים');
      expect(body.indexOf('אם הפרטים נכונים')).toBeLessThan(body.indexOf('נשלח קוד'));
    }
  });

  it('states the conditional up front, before anything is submitted', async () => {
    renderPage();
    const hint = await screen.findByTestId('forgot-password-privacy-note');
    expect(hint.textContent).toContain('אם הפרטים נכונים');
  });

  it('demands a school before submitting', async () => {
    renderPage();
    fireEvent.change(await screen.findByTestId('forgot-password-id-number'), {
      target: { value: '303977367' },
    });
    fireEvent.click(screen.getByTestId('forgot-password-submit'));

    expect(await screen.findByTestId('forgot-password-error')).toBeInTheDocument();
    expect(startRecovery).not.toHaveBeenCalled();
  });

  it('demands an ID number before submitting', async () => {
    renderPage();
    fireEvent.focus(await screen.findByTestId('forgot-password-school-selector'));
    fireEvent.mouseDown(await screen.findByTestId(`school-option-${SCHOOL.semel}`));
    fireEvent.click(screen.getByTestId('forgot-password-submit'));

    expect(await screen.findByTestId('forgot-password-error')).toBeInTheDocument();
    expect(startRecovery).not.toHaveBeenCalled();
  });

  it('renders the ID field left-to-right and numeric, so digits do not reorder', async () => {
    // RTL detail that bites: an ID number typed into an RTL input renders with
    // its digits in the wrong visual order.
    renderPage();
    const input = await screen.findByTestId('forgot-password-id-number');
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(input).toHaveAttribute('inputMode', 'numeric');
  });

  it('tells a throttled parent to wait rather than leaving them retrying', async () => {
    startRecovery.mockRejectedValue(
      new ApiError(429, 'throttled', {
        error: { code: 'RECOVERY_THROTTLED', message: 'throttled', details: [] },
      }),
    );
    renderPage();
    await submit();

    await waitFor(() => {
      expect(screen.getByTestId('forgot-password-error').textContent).toMatch(
        /[֐-׿]/,
      );
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('reports an outage as an outage', async () => {
    startRecovery.mockRejectedValue(
      new ApiError(502, 'down', {
        error: { code: 'UPSTREAM_ERROR', message: 'down', details: [] },
      }),
    );
    renderPage();
    await submit();

    await waitFor(() => {
      expect(screen.getByTestId('forgot-password-error')).toBeInTheDocument();
    });
  });

  it('offers a way back to sign-in', async () => {
    renderPage();
    expect(await screen.findByTestId('forgot-password-back-to-sign-in')).toHaveAttribute(
      'href',
      '/auth/sign-in',
    );
  });
});

describe('ForgotPasswordPageClient minor fixes', () => {
  it('carries the two-channel answer into the reset form', async () => {
    // The 202 already says so. Without passing it on, a two-channel parent
    // submits once, reads SECOND_CODE_REQUIRED, and only then sees the second
    // field -- a round trip the server already told us was coming.
    startRecovery.mockResolvedValue({
      recoveryId: 'rid-2',
      requiresSecondChannel: true,
      channel: 'email',
    });
    renderPage();
    await submit();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/auth/reset-password?rid=rid-2&semel=${SCHOOL.semel}&two=1`,
      );
    });
  });

  it('omits the flag entirely for a single-channel recovery', async () => {
    renderPage();
    await submit();

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls[0][0])).not.toContain('two=');
  });
});
