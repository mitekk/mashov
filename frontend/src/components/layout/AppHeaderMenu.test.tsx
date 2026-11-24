import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const toggleTheme = vi.fn();
const mutate = vi.fn();
const openDialog = vi.fn();
let theme = 'light';
let isPending = false;

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme, setTheme: vi.fn(), toggleTheme }),
}));
vi.mock('@/hooks/useDashboard', () => ({
  useSyncRefresh: () => ({ mutate, isPending }),
}));
vi.mock('@/hooks/useFeedbackDialog', () => ({
  useFeedbackDialog: () => ({ open: false, thanks: false, openDialog, closeDialog: vi.fn() }),
}));

const { AppHeaderMenu } = await import('./AppHeaderMenu');

beforeAll(() => {
  // Radix's Popper measures its content. jsdom has neither observer.
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= Observer as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  toggleTheme.mockClear();
  mutate.mockClear();
  openDialog.mockClear();
  theme = 'light';
  isPending = false;
});

/** Radix opens the menu on keydown, which jsdom (no PointerEvent) can send. */
function openMenu(): void {
  fireEvent.keyDown(screen.getByTestId('header-menu-trigger'), { key: 'Enter' });
}

describe('AppHeaderMenu', () => {
  it('names the trigger for a screen reader, having no visible text', () => {
    render(<AppHeaderMenu canSendFeedback />);

    expect(screen.getByTestId('header-menu-trigger').getAttribute('aria-label')).toBe(
      'עוד פעולות',
    );
  });

  it('keeps the trigger a 44px tap target', () => {
    // responsive.spec.ts asserts >=44x44 in a real engine; this is the guard
    // for the class that gets it there.
    render(<AppHeaderMenu canSendFeedback />);

    expect(screen.getByTestId('header-menu-trigger').className).toContain('tap-target');
  });

  it('shows feedback, theme and sync once opened', () => {
    render(<AppHeaderMenu canSendFeedback />);

    openMenu();

    expect(screen.getByTestId('header-menu-feedback')).not.toBeNull();
    expect(screen.getByTestId('header-menu-theme')).not.toBeNull();
    expect(screen.getByTestId('header-menu-refresh')).not.toBeNull();
  });

  /**
   * The trap this component had to be written around. Both header branches are
   * in the DOM at every width -- one hidden by Tailwind -- and Playwright's
   * strict mode counts hidden matches, so reusing `theme-toggle`,
   * `refresh-button` or `feedback-launcher-button` here would resolve every
   * existing locator to two nodes and break theme.spec.ts and feedback.spec.ts.
   */
  it('reuses none of the inline controls testids', () => {
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    expect(screen.queryByTestId('refresh-button')).toBeNull();
    expect(screen.queryByTestId('feedback-launcher-button')).toBeNull();
  });

  it('opens the shared feedback dialog rather than one of its own', () => {
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-feedback'));

    expect(openDialog).toHaveBeenCalledTimes(1);
  });

  it('omits feedback with no household to attach it to', () => {
    // Same rule the inline branch follows: feedback needs a household, so it
    // is absent for the paint before `me` resolves.
    render(<AppHeaderMenu canSendFeedback={false} />);
    openMenu();

    expect(screen.queryByTestId('header-menu-feedback')).toBeNull();
    expect(screen.getByTestId('header-menu-theme')).not.toBeNull();
  });

  it('labels the theme item with the mode it switches to', () => {
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    expect(screen.getByTestId('header-menu-theme').textContent).toContain('מצב כהה');
  });

  it('labels the theme item the other way round in dark mode', () => {
    theme = 'dark';
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    expect(screen.getByTestId('header-menu-theme').textContent).toContain('מצב בהיר');
  });

  it('toggles the theme from the menu', () => {
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-theme'));

    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('triggers a household sync from the menu', () => {
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-refresh'));

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('disables sync while one is already running', () => {
    isPending = true;
    render(<AppHeaderMenu canSendFeedback />);
    openMenu();

    const item = screen.getByTestId('header-menu-refresh');
    expect(item.getAttribute('data-disabled')).not.toBeNull();

    fireEvent.click(item);
    expect(mutate).not.toHaveBeenCalled();
  });
});
