import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParentProfile } from '@/types/api';
import { ApiError } from '@/api/client';

const submitFeedback = vi.fn();
vi.mock('@/api/feedback', () => ({
  submitFeedback: (...args: unknown[]) => submitFeedback(...args),
}));

const useProfile = vi.fn();
vi.mock('@/hooks/useSettings', () => ({
  useProfile: () => useProfile(),
  useSourceHealth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/children/abc-123',
}));

const { FeedbackDialog } = await import('./FeedbackDialog');

function profile(overrides: Partial<ParentProfile> = {}): ParentProfile {
  return {
    householdConnectionId: 'conn-a',
    upstreamUserId: 'up-1',
    displayName: 'קורס דמיטרי',
    email: 'parent@example.com',
    cellphone: '0500000000',
    schoolName: 'אורט רמון',
    schoolYear: 2027,
    schoolCode: 111111,
    detailsState: 1,
    children: [],
    ...overrides,
  } as ParentProfile;
}

function renderDialog(onSent = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <FeedbackDialog open onOpenChange={onOpenChange} onSent={onSent} />
    </QueryClientProvider>,
  );
  return { onOpenChange, onSent };
}

function content(): HTMLTextAreaElement {
  return screen.getByTestId('feedback-content-textarea') as HTMLTextAreaElement;
}

function submit(): HTMLButtonElement {
  return screen.getByTestId('feedback-submit-button') as HTMLButtonElement;
}

function type(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    submitFeedback.mockReset();
    submitFeedback.mockResolvedValue({
      id: 'feedback-1',
      subject: 'bug',
      createdAt: '2026-11-23T10:00:00.000Z',
    });
    useProfile.mockReturnValue({ data: [] });
  });

  it('opens on a real subject, so the parent is not asked to pick nothing', () => {
    renderDialog();

    expect((screen.getByTestId('feedback-subject-select') as HTMLSelectElement).value).toBe('bug');
  });

  it('asks for no free-text label until the subject is אחר', () => {
    renderDialog();

    expect(screen.queryByTestId('feedback-subject-other-input')).toBeNull();

    type(screen.getByTestId('feedback-subject-select'), 'other');

    expect(screen.queryByTestId('feedback-subject-other-input')).not.toBeNull();
  });

  it('refuses to send אחר without a label, and says which field', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-subject-select'), 'other');
    type(content(), 'הדף נטען לאט');

    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId('feedback-error').textContent).toContain('נושא');
    });
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('sends אחר once the label is filled', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-subject-select'), 'other');
    type(screen.getByTestId('feedback-subject-other-input'), 'הדף נטען לאט');
    type(content(), 'לוקח המון זמן');

    fireEvent.click(submit());

    await waitFor(() => expect(submitFeedback).toHaveBeenCalled());
    expect(submitFeedback.mock.calls[0][0]).toMatchObject({
      subject: 'other',
      subjectOther: 'הדף נטען לאט',
      content: 'לוקח המון זמן',
    });
  });

  it('counts the characters the parent has written', () => {
    renderDialog();

    expect(screen.getByTestId('feedback-content-counter').textContent).toContain('0');

    type(content(), 'חמש!');

    expect(screen.getByTestId('feedback-content-counter').textContent).toContain('4');
  });

  it('will not send an empty report', () => {
    renderDialog();

    expect(submit().disabled).toBe(true);

    type(content(), 'משהו');

    expect(submit().disabled).toBe(false);
  });

  it('will not send whitespace alone', () => {
    renderDialog();

    type(content(), '     ');

    expect(submit().disabled).toBe(true);
  });

  it('disables the button and says so while sending', async () => {
    let release: () => void = () => {};
    submitFeedback.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'f1', subject: 'bug', createdAt: 'now' });
        }),
    );
    renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(submit().textContent).toContain('שולח');

    release();
  });

  /**
   * The per-user hourly limit. 429 is the one status worth its own words --
   * "try again" is actionable, where the generic copy is not.
   */
  it('tells the parent to come back later on 429', async () => {
    submitFeedback.mockRejectedValue(
      new ApiError(429, 'Too many feedback reports.', {
        error: { code: 'RATE_LIMIT_EXCEEDED' },
      }),
    );
    renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId('feedback-error').textContent).toContain('נסו שוב מאוחר יותר');
    });
  });

  it('shows generic retry copy on any other failure', async () => {
    submitFeedback.mockRejectedValue(new ApiError(500, 'boom', {}));
    renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId('feedback-error').textContent).toContain('נסו שוב');
    });
    expect(screen.getByTestId('feedback-error').textContent).not.toContain('boom');
  });

  it('prefills the reply address from the Mashov profile', () => {
    useProfile.mockReturnValue({ data: [profile({ email: 'mum@example.com' })] });
    renderDialog();

    expect((screen.getByTestId('feedback-email-input') as HTMLInputElement).value).toBe(
      'mum@example.com',
    );
  });

  it('takes the first school that actually has an address', () => {
    useProfile.mockReturnValue({
      data: [profile({ email: '' }), profile({ email: 'dad@example.com' })],
    });
    renderDialog();

    expect((screen.getByTestId('feedback-email-input') as HTMLInputElement).value).toBe(
      'dad@example.com',
    );
  });

  it('leaves the address empty when no school has one', () => {
    useProfile.mockReturnValue({ data: [profile({ email: '' })] });
    renderDialog();

    expect((screen.getByTestId('feedback-email-input') as HTMLInputElement).value).toBe('');
  });

  it('refuses an address that is not an address', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-email-input'), 'not-an-email');
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(screen.getByTestId('feedback-error')).not.toBeNull());
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('sends no address at all when the parent clears the field', async () => {
    useProfile.mockReturnValue({ data: [profile({ email: 'mum@example.com' })] });
    renderDialog();
    type(screen.getByTestId('feedback-email-input'), '');
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(submitFeedback).toHaveBeenCalled());
    expect(submitFeedback.mock.calls[0][0].contactEmail).toBeUndefined();
  });

  /** Reproduction context the parent never has to describe. */
  it('captures the page, the viewport and the build', async () => {
    renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(submitFeedback).toHaveBeenCalled());
    expect(submitFeedback.mock.calls[0][0]).toMatchObject({
      pagePath: '/children/abc-123',
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  });

  it('closes and reports the send so the thank-you can be shown', async () => {
    const { onOpenChange, onSent } = renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes without sending anything on cancel', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByTestId('feedback-cancel-button'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(submitFeedback).not.toHaveBeenCalled();
  });
});
