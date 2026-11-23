import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stub, so the launcher's own contract is what is under test -- and so this
 * file renders with NO QueryClientProvider, which is the point: the launcher
 * lives in `UserHeader`, whose own test mounts it without one. A TanStack hook
 * called here rather than inside the dialog would break that test.
 */
vi.mock('./FeedbackDialog', () => ({
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
        <button
          type="button"
          data-testid="stub-send"
          onClick={() => {
            onOpenChange(false);
            onSent();
          }}
        >
          send
        </button>
      </div>
    ) : null,
}));

const { FeedbackLauncher, FEEDBACK_THANKS_MS } = await import('./FeedbackLauncher');

function open(): void {
  fireEvent.click(screen.getByTestId('feedback-launcher-button'));
}

describe('FeedbackLauncher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts nothing but the trigger until it is pressed', () => {
    render(<FeedbackLauncher />);

    expect(screen.getByTestId('feedback-launcher-button')).not.toBeNull();
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
  });

  it('names itself for a screen reader, having no visible text', () => {
    render(<FeedbackLauncher />);

    expect(screen.getByTestId('feedback-launcher-button').getAttribute('aria-label')).toBe(
      'שליחת משוב',
    );
  });

  it('opens the form on press', () => {
    render(<FeedbackLauncher />);

    open();

    expect(screen.queryByTestId('feedback-dialog')).not.toBeNull();
  });

  it('thanks the parent once the report is sent', () => {
    render(<FeedbackLauncher />);
    open();

    fireEvent.click(screen.getByTestId('stub-send'));

    expect(screen.getByTestId('feedback-thanks')).not.toBeNull();
    // The form is gone; the banner is the only thing left on screen.
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
  });

  it('lets the parent dismiss the thank-you', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    fireEvent.click(screen.getByTestId('feedback-thanks-dismiss'));

    expect(screen.queryByTestId('feedback-thanks')).toBeNull();
  });

  it('clears the thank-you by itself', () => {
    vi.useFakeTimers();
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    act(() => {
      vi.advanceTimersByTime(FEEDBACK_THANKS_MS - 1);
    });
    expect(screen.queryByTestId('feedback-thanks')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('feedback-thanks')).toBeNull();
  });

  it('announces the thank-you politely rather than as an alert', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    expect(screen.getByTestId('feedback-thanks').getAttribute('role')).toBe('status');
  });
});
