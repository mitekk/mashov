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

  /**
   * A live region that enters the DOM at the same moment as its text is often
   * not announced at all (NVDA, VoiceOver). The parent taps send, the dialog
   * closes, focus returns to the launcher, and a blind parent is told nothing
   * -- so they send again and hit the hourly limit. The region has to be in
   * the tree before the text lands in it.
   */
  it('keeps the live region mounted so the thank-you is actually announced', () => {
    render(<FeedbackLauncher />);

    const region = screen.getByTestId('feedback-thanks-live');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');

    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    // The same node, now carrying text -- not a newly inserted one.
    expect(screen.getByTestId('feedback-thanks-live')).toBe(region);
    expect(region.textContent).toContain('תודה');
  });

  it('empties the live region when the thank-you clears', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    fireEvent.click(screen.getByTestId('feedback-thanks-dismiss'));

    expect(screen.getByTestId('feedback-thanks-live').textContent?.trim()).toBe('');
  });

  /**
   * The wrapper is `fixed bottom-0 z-[60]` with `pb-nav` padding, so its box
   * extends down across the whole of BottomNav (`z-50`) -- invisible, above
   * it, and for the full ten seconds. `aria-hidden` does not affect hit
   * testing, so without this a parent who sends feedback and immediately taps
   * a nav tab hits nothing at all.
   */
  it('lets taps through to the nav underneath it', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    const wrapper = screen.getByTestId('feedback-thanks');
    expect(wrapper.className).toContain('pointer-events-none');
    // ...while the banner itself stays tappable, or the dismiss X is dead.
    const banner = wrapper.querySelector('span');
    expect(banner?.className).toContain('pointer-events-auto');
  });

  it('keeps the dismiss button out of the tab order, being aria-hidden', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    // A control inside an aria-hidden subtree that is still tabbable is a
    // WCAG 4.1.2 failure: a keyboard user reaches a button that, as far as
    // the accessibility tree is concerned, does not exist.
    expect(screen.getByTestId('feedback-thanks-dismiss').getAttribute('tabindex')).toBe('-1');
  });

  /** The visible banner must not be read a second time after the region. */
  it('hides the visible banner from the accessibility tree', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    expect(screen.getByTestId('feedback-thanks').getAttribute('aria-hidden')).toBe('true');
  });

  it('announces the thank-you politely rather than as an alert', () => {
    render(<FeedbackLauncher />);
    open();
    fireEvent.click(screen.getByTestId('stub-send'));

    expect(screen.getByTestId('feedback-thanks-live').getAttribute('role')).toBe('status');
  });
});
