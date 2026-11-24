import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stub, so the provider's own contract is what is under test -- and so this
 * file renders with NO QueryClientProvider, which is the point: the provider
 * mounts on every authenticated screen, so a TanStack hook here rather than
 * inside the dialog would put a request on every page load.
 */
vi.mock('@/components/feedback/FeedbackDialog', () => ({
  FeedbackDialog: ({
    open,
    onOpenChange,
    onSent,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSent: () => void;
  }) =>
    open ? (
      <div data-testid="feedback-dialog">
        <button type="button" data-testid="stub-send" onClick={() => {
          onOpenChange(false);
          onSent();
        }}>
          send
        </button>
        <button type="button" data-testid="stub-close" onClick={() => onOpenChange(false)}>
          close
        </button>
      </div>
    ) : null,
}));

const { FeedbackDialogProvider, FEEDBACK_THANKS_MS, useFeedbackDialog } = await import(
  './useFeedbackDialog'
);

function Probe() {
  const { open, thanks, openDialog, closeDialog } = useFeedbackDialog();
  return (
    <>
      <span data-testid="state">{`${open ? 'open' : 'shut'}/${thanks ? 'thanks' : 'quiet'}`}</span>
      <button type="button" data-testid="probe-open" onClick={openDialog}>
        open
      </button>
      <button type="button" data-testid="probe-close" onClick={closeDialog}>
        close
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <FeedbackDialogProvider>
      <Probe />
    </FeedbackDialogProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useFeedbackDialog', () => {
  it('refuses to be used outside its provider', () => {
    // Without this the failure would be a confusing "cannot read openDialog of
    // null" inside whichever trigger forgot the provider.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Probe />)).toThrow(/must be used within FeedbackDialogProvider/);

    consoleError.mockRestore();
  });

  it('starts shut, with nothing of the dialog mounted', () => {
    renderProvider();

    expect(screen.getByTestId('state').textContent).toBe('shut/quiet');
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
  });

  it('opens and closes through the context', () => {
    renderProvider();

    fireEvent.click(screen.getByTestId('probe-open'));
    expect(screen.getByTestId('state').textContent).toBe('open/quiet');
    expect(screen.getByTestId('feedback-dialog')).not.toBeNull();

    fireEvent.click(screen.getByTestId('probe-close'));
    expect(screen.getByTestId('state').textContent).toBe('shut/quiet');
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
  });

  it('keeps one live region mounted from the very first render', () => {
    // A live region inserted at the same moment as its text is frequently not
    // announced at all (NVDA, VoiceOver), which would leave a blind parent
    // with no confirmation -- and a second report into the hourly limit.
    renderProvider();

    const regions = screen.getAllByTestId('feedback-thanks-live');
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('role')).toBe('status');
    expect(regions[0].textContent?.trim()).toBe('');
  });

  it('clears a previous thank-you when the form is reopened', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('probe-open'));
    fireEvent.click(screen.getByTestId('stub-send'));
    expect(screen.getByTestId('state').textContent).toBe('shut/thanks');

    fireEvent.click(screen.getByTestId('probe-open'));

    // Not "open/thanks": a banner thanking them for the last report while they
    // type the next one reads as if this one was already sent.
    expect(screen.getByTestId('state').textContent).toBe('open/quiet');
  });

  it('leaves no thank-you behind when the form is merely dismissed', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('probe-open'));

    fireEvent.click(screen.getByTestId('stub-close'));

    expect(screen.getByTestId('state').textContent).toBe('shut/quiet');
    expect(screen.queryByTestId('feedback-thanks')).toBeNull();
  });

  it('retires the thank-you on its own timer', () => {
    vi.useFakeTimers();
    renderProvider();
    fireEvent.click(screen.getByTestId('probe-open'));
    fireEvent.click(screen.getByTestId('stub-send'));

    act(() => {
      vi.advanceTimersByTime(FEEDBACK_THANKS_MS - 1);
    });
    expect(screen.getByTestId('state').textContent).toBe('shut/thanks');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('state').textContent).toBe('shut/quiet');
  });

  it('does not strand the timer when the provider unmounts mid-thanks', () => {
    vi.useFakeTimers();
    const { unmount } = renderProvider();
    fireEvent.click(screen.getByTestId('probe-open'));
    fireEvent.click(screen.getByTestId('stub-send'));

    unmount();

    // A setState on an unmounted provider would warn; advancing past the
    // timeout proves the cleanup cleared it.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(FEEDBACK_THANKS_MS * 2);
      });
    }).not.toThrow();
  });
});
