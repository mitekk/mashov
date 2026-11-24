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

  /**
   * Both halves matter and they pull against each other. Autofocusing the
   * textarea would raise the phone keyboard over the subject picker before the
   * parent had read it -- but simply preventing the open focus leaves focus on
   * the launcher button OUTSIDE the dialog, and Radix's focus trap only holds
   * once focus is inside, so the next Tab walks the page behind the overlay.
   * So focus lands on the dialog itself.
   */
  it('puts focus inside the dialog without landing on a text field', () => {
    renderDialog();

    const dialog = screen.getByTestId('feedback-dialog');
    expect(document.activeElement).not.toBeNull();
    expect(dialog === document.activeElement || dialog.contains(document.activeElement)).toBe(
      true,
    );
    expect(document.activeElement).not.toBe(content());
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
      expect(screen.getByTestId('feedback-subject-other-error').textContent).toContain('נושא');
    });
    // The banner is for send failures; a field's own message sits under it.
    expect(screen.queryByTestId('feedback-error')).toBeNull();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  /**
   * `.claude/rules/frontend.md`: "show field-level errors inline". One
   * aggregated first-error-only line costs a parent with two bad fields a
   * second round trip, and a screen-reader user hears a sentence with no way
   * to tell which of the four controls it belongs to.
   */
  it('marks every offending field, not just the first', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-subject-select'), 'other');
    type(screen.getByTestId('feedback-email-input'), 'not-an-email');
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId('feedback-subject-other-error')).not.toBeNull();
    });
    expect(screen.getByTestId('feedback-email-error')).not.toBeNull();
  });

  it('points each invalid input at its own message', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-email-input'), 'not-an-email');
    type(content(), 'משהו');

    fireEvent.click(submit());

    const email = screen.getByTestId('feedback-email-input');
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'));
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    const message = screen.getByTestId('feedback-email-error');
    expect(describedBy.split(/\s+/)).toContain(message.id);
  });

  it('tells a screen reader the content limit, not only a sighted one', () => {
    renderDialog();

    const textarea = content();
    const counter = screen.getByTestId('feedback-content-counter');
    expect(counter.id).not.toBe('');
    expect((textarea.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(counter.id);
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

  /**
   * The whole dialog is `dir="rtl"`, and bidi reorders a bare `0 / 2000` into
   * `2000 / 0` on screen -- the parent reads the cap as their own count. The
   * pair has to be isolated LTR; jsdom cannot lay out bidi, so the isolation
   * attribute is what this asserts.
   */
  it('keeps the counter pair from reading backwards in RTL', () => {
    renderDialog();
    type(content(), 'ארבע');

    const counter = screen.getByTestId('feedback-content-counter');
    const isolated = counter.querySelector('[dir="ltr"]');
    expect(isolated).not.toBeNull();
    expect(isolated?.textContent?.replace(/\s+/g, ' ').trim()).toBe('4 / 2000');
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

  /**
   * The client check used to be looser than the server's `@IsEmail`, so an
   * address like `a@b..c` passed here and was refused there -- and the generic
   * "try again" copy sent the parent round a loop that could never succeed,
   * with no field marked.
   */
  it('catches an address the server would reject, before sending', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-email-input'), 'parent@b..c');
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(screen.getByTestId('feedback-email-error')).not.toBeNull());
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  /** And if one still gets through, "try again" must not be the advice. */
  it('tells the parent to check the fields on a 400, not merely to retry', async () => {
    submitFeedback.mockRejectedValue(
      new ApiError(400, 'Validation failed', {
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: [] },
      }),
    );
    renderDialog();
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId('feedback-error').textContent).toContain('בדקו');
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

  /**
   * The profile query can resolve AFTER the parent has typed. Without a dirty
   * check the prefill effect replaces their correction with the Mashov
   * address, silently, and the reply goes to the one they chose not to use.
   */
  it('does not overwrite an address the parent typed before the profile arrived', () => {
    useProfile.mockReturnValue({ data: undefined });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <FeedbackDialog open onOpenChange={vi.fn()} onSent={vi.fn()} />
      </QueryClientProvider>,
    );

    type(screen.getByTestId('feedback-email-input'), 'mum.work@example.com');

    // The query settles a moment later, as it does on a cold load.
    useProfile.mockReturnValue({ data: [profile({ email: 'mashov@example.com' })] });
    rerender(
      <QueryClientProvider client={client}>
        <FeedbackDialog open onOpenChange={vi.fn()} onSent={vi.fn()} />
      </QueryClientProvider>,
    );

    expect((screen.getByTestId('feedback-email-input') as HTMLInputElement).value).toBe(
      'mum.work@example.com',
    );
  });

  it('still prefills a late profile into a field the parent has not touched', () => {
    useProfile.mockReturnValue({ data: undefined });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <FeedbackDialog open onOpenChange={vi.fn()} onSent={vi.fn()} />
      </QueryClientProvider>,
    );

    useProfile.mockReturnValue({ data: [profile({ email: 'mashov@example.com' })] });
    rerender(
      <QueryClientProvider client={client}>
        <FeedbackDialog open onOpenChange={vi.fn()} onSent={vi.fn()} />
      </QueryClientProvider>,
    );

    expect((screen.getByTestId('feedback-email-input') as HTMLInputElement).value).toBe(
      'mashov@example.com',
    );
  });

  it('refuses an address that is not an address', async () => {
    renderDialog();
    type(screen.getByTestId('feedback-email-input'), 'not-an-email');
    type(content(), 'משהו');

    fireEvent.click(submit());

    await waitFor(() => expect(screen.getByTestId('feedback-email-error')).not.toBeNull());
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
