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
// `next/link` renders an anchor without the app router in the tree.
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
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
  fireEvent.keyDown(screen.getByTestId('header-profile-trigger'), { key: 'Enter' });
}

function renderMenu(props: Partial<React.ComponentProps<typeof AppHeaderMenu>> = {}) {
  return render(
    <AppHeaderMenu
      displayName="קורס דמיטרי"
      initials="קד"
      suffix=" · 2 ילדים"
      canSendFeedback
      {...props}
    />,
  );
}

describe('AppHeaderMenu', () => {
  it('names the trigger after the parent, since its visible text is initials', () => {
    renderMenu();

    expect(screen.getByTestId('header-profile-trigger').getAttribute('aria-label')).toBe(
      'קורס דמיטרי · 2 ילדים — תפריט',
    );
  });

  it('falls back to פרופיל when the name has not arrived', () => {
    renderMenu({ displayName: undefined, initials: '?', suffix: '' });

    const trigger = screen.getByTestId('header-profile-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('פרופיל — תפריט');
    expect(trigger.textContent).toBe('?');
  });

  /** `lg`, not `sm`: below that the page title owns the header row. */
  it('hides the name below lg and keeps the initials at every width', () => {
    renderMenu();

    const name = screen.getByText(/קורס דמיטרי · 2 ילדים/);
    expect(name.className).toContain('hidden');
    expect(name.className).toContain('lg:block');
    expect(screen.getByText('קד').className).not.toContain('hidden');
  });

  it('keeps the trigger a 44px tap target', () => {
    // responsive.spec.ts asserts >=44x44 in a real engine; this is the guard
    // for the class that gets it there.
    renderMenu();

    expect(screen.getByTestId('header-profile-trigger').className).toContain('tap-target');
  });

  it('shows settings, feedback, theme and sync once opened', () => {
    renderMenu();

    openMenu();

    expect(screen.getByTestId('header-menu-settings')).not.toBeNull();
    expect(screen.getByTestId('header-menu-feedback')).not.toBeNull();
    expect(screen.getByTestId('header-menu-theme')).not.toBeNull();
    expect(screen.getByTestId('header-menu-refresh')).not.toBeNull();
  });

  /**
   * Keeps הגדרות a real anchor: `asChild` is what hands Radix's keyboard and
   * `onSelect` handling to `next/link`, so the item navigates from the
   * keyboard and not only under the mouse.
   */
  it('routes הגדרות to /more through a real link', () => {
    renderMenu();
    openMenu();

    const item = screen.getByTestId('header-menu-settings');
    expect(item.tagName).toBe('A');
    expect(item.getAttribute('href')).toBe('/more');
    expect(item.textContent).toContain('הגדרות');
  });

  it('opens the shared feedback dialog rather than one of its own', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-feedback'));

    expect(openDialog).toHaveBeenCalledTimes(1);
  });

  it('omits feedback with no household to attach it to', () => {
    // Same rule the inline branch follows: feedback needs a household, so it
    // is absent for the paint before `me` resolves.
    renderMenu({ canSendFeedback: false });
    openMenu();

    expect(screen.queryByTestId('header-menu-feedback')).toBeNull();
    expect(screen.getByTestId('header-menu-theme')).not.toBeNull();
  });

  it('labels the theme item with the mode it switches to', () => {
    renderMenu();
    openMenu();

    expect(screen.getByTestId('header-menu-theme').textContent).toContain('מצב כהה');
  });

  it('labels the theme item the other way round in dark mode', () => {
    theme = 'dark';
    renderMenu();
    openMenu();

    expect(screen.getByTestId('header-menu-theme').textContent).toContain('מצב בהיר');
  });

  it('toggles the theme from the menu', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-theme'));

    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('triggers a household sync from the menu', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByTestId('header-menu-refresh'));

    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('disables sync while one is already running', () => {
    isPending = true;
    renderMenu();
    openMenu();

    const item = screen.getByTestId('header-menu-refresh');
    expect(item.getAttribute('data-disabled')).not.toBeNull();

    fireEvent.click(item);
    expect(mutate).not.toHaveBeenCalled();
  });

  // Radix's modal mode wraps the content in `react-remove-scroll`, which sets
  // `body { overflow: hidden !important; margin-right: <gap>px }`. Under
  // `dir="rtl"` the scrollbar is on the LEFT, so removing it slides the page
  // left while the compensation lands on the right -- the shift reported on
  // the live app. The `overflow: hidden` also defeats `globals.css`'s
  // deliberate `overflow-x: clip`, which keeps `position: sticky` working.
  it('does not lock body scroll while the menu is open', () => {
    renderMenu();
    openMenu();

    expect(screen.getByTestId('header-menu-settings')).toBeTruthy();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(document.body.style.marginRight).toBe('');
  });
});
