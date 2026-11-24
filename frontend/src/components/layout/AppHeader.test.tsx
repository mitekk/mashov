import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUser } from '@/types/api';

const useMe = vi.fn();

vi.mock('@/hooks/useAuth', () => ({ useMe: () => useMe() }));
vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));
vi.mock('@/hooks/useDashboard', () => ({
  useSyncRefresh: () => ({ mutate: vi.fn(), isPending: false }),
}));
// `next/link` renders an anchor without the app router in the tree.
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

const { AppHeader } = await import('./AppHeader');

function me(overrides: Partial<AppUser> = {}): AppUser {
  return {
    mashovUserId: 'mashov-1',
    username: 'parent',
    displayName: 'קורס דמיטרי',
    childrenCount: 0,
    schools: [],
    ...overrides,
  };
}

function profileLink(): HTMLElement {
  return screen.getByTestId('header-profile-link');
}

beforeEach(() => {
  useMe.mockReset();
});

describe('AppHeader', () => {
  it('names no children when the household has none', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 0 }) });
    render(<AppHeader />);

    expect(profileLink().textContent).toBe('קורס דמיטריקד');
  });

  it('says ילד אחד for one child', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 1 }) });
    render(<AppHeader />);

    expect(profileLink().textContent).toContain('קורס דמיטרי · ילד אחד');
  });

  it('counts children in the plural', () => {
    // The two-school case the count is for: the header used to read
    // "קורס דמיטרי [מיקה ז8]" -- one school's child above every school's
    // content.
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    expect(profileLink().textContent).toContain('קורס דמיטרי · 2 ילדים');
  });

  it('puts the count in the aria-label too', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    expect(profileLink().getAttribute('aria-label')).toBe('קורס דמיטרי · 2 ילדים — הגדרות');
  });

  it('takes initials from the stripped name', () => {
    // `getInitials` runs on what the API sends. Stripped, "קורס דמיטרי" gives
    // קד; with the bracket still attached it gave the child's initial.
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    expect(screen.getByText('קד')).not.toBeNull();
  });

  /**
   * The whole reason this replaced `UserHeader`, which returned `null` until
   * `me` resolved. `pt-safe` lives on this element now -- a `sticky top-0` box
   * parks under the notch, and padding on the AppShell wrapper above it does
   * nothing once it is stuck -- so a header that can vanish would drop the
   * notch padding on first paint.
   */
  it('renders its shell before `me` has loaded', () => {
    useMe.mockReturnValue({ data: undefined });
    render(<AppHeader />);

    const header = screen.getByTestId('app-header');
    expect(header.className).toContain('pt-safe');
    expect(screen.queryByTestId('header-profile-link')).toBeNull();
  });

  it('withholds feedback until there is a household to attach it to', () => {
    useMe.mockReturnValue({ data: undefined });
    render(<AppHeader />);

    expect(screen.queryByTestId('feedback-launcher-button')).toBeNull();
  });

  it('offers feedback once the household is known', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    expect(screen.getByTestId('feedback-launcher-button')).not.toBeNull();
  });

  it('keeps a fixed row height so nothing shifts when `me` arrives', () => {
    useMe.mockReturnValue({ data: undefined });
    const { container } = render(<AppHeader />);
    const row = container.querySelector('[data-testid="app-header"] > div');

    expect(row?.className).toContain('h-14');
  });

  /**
   * `z-40`, not `z-50`. `AppNav` and every Radix dialog overlay are `z-50` and
   * `Select` is `z-[70]`: a header at `z-50` would float over an open modal.
   */
  it('sticks below the nav and every dialog overlay', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    const header = screen.getByTestId('app-header');
    expect(header.className).toContain('sticky');
    expect(header.className).toContain('top-0');
    expect(header.className).toContain('z-40');
    expect(header.className).not.toContain('z-50');
  });

  it('cancels the notch padding at lg, where nothing overlays the status bar', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    expect(screen.getByTestId('app-header').className).toContain('lg:pt-0');
  });

  it('carries the class the scroll fade is driven through', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    // `.app-header` in globals.css reads `--app-header-p`; useHeaderScroll
    // writes it. Without the class the header simply never fades.
    expect(screen.getByTestId('app-header').className).toContain('app-header');
  });

  it('owns the four app-wide controls so no page has to remember them', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    expect(screen.getByTestId('feedback-launcher-button')).not.toBeNull();
    expect(screen.getByTestId('theme-toggle')).not.toBeNull();
    expect(screen.getByTestId('refresh-button')).not.toBeNull();
    expect(screen.getByTestId('header-profile-link')).not.toBeNull();
  });

  /**
   * Both branches are mounted at every width and Tailwind hides one, so each
   * testid still resolves to exactly one node -- Playwright's strict mode
   * counts hidden matches.
   */
  it('shows the inline row from sm up and the overflow menu below it', () => {
    useMe.mockReturnValue({ data: me() });
    const { container } = render(<AppHeader />);

    const inline = container.querySelector('[data-testid="app-header-inline"]');
    expect(inline?.className).toContain('hidden');
    expect(inline?.className).toContain('sm:flex');
    expect(screen.getByTestId('header-menu-trigger').className).toContain('sm:hidden');
    expect(screen.getAllByTestId('theme-toggle')).toHaveLength(1);
    expect(screen.getAllByTestId('refresh-button')).toHaveLength(1);
    expect(screen.getAllByTestId('feedback-launcher-button')).toHaveLength(1);
  });

  it('hides the name below sm, where only the avatar fits', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    const name = screen.getByText(/קורס דמיטרי · 2 ילדים/);
    expect(name.className).toContain('hidden');
    expect(name.className).toContain('sm:block');
  });
});
