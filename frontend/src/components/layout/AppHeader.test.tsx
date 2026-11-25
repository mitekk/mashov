import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUser } from '@/types/api';

const useMe = vi.fn();

vi.mock('@/hooks/useAuth', () => ({ useMe: () => useMe() }));
vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));
const useDashboard = vi.fn(() => ({ data: undefined }) as { data: unknown });
vi.mock('@/hooks/useDashboard', () => ({
  useSyncRefresh: () => ({ mutate: vi.fn(), isPending: false }),
  useDashboard: () => useDashboard(),
}));
const pathname = vi.fn(() => '/home');
vi.mock('next/navigation', () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ push: vi.fn() }),
}));
// The switcher has its own suite; it needs a QueryClient and the child list.
vi.mock('./HeaderChildSwitcher', () => ({ HeaderChildSwitcher: () => null }));
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

function profileTrigger(): HTMLElement {
  return screen.getByTestId('header-profile-trigger');
}

beforeEach(() => {
  useMe.mockReset();
  useDashboard.mockReset();
  useDashboard.mockReturnValue({ data: undefined });
  pathname.mockReset();
  pathname.mockReturnValue('/home');
});

describe('AppHeader', () => {
  it('names no children when the household has none', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 0 }) });
    render(<AppHeader />);

    expect(profileTrigger().textContent).toBe('קורס דמיטריקד');
  });

  it('says ילד אחד for one child', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 1 }) });
    render(<AppHeader />);

    expect(profileTrigger().textContent).toContain('קורס דמיטרי · ילד אחד');
  });

  it('counts children in the plural', () => {
    // The two-school case the count is for: the header used to read
    // "קורס דמיטרי [מיקה ז8]" -- one school's child above every school's
    // content.
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    expect(profileTrigger().textContent).toContain('קורס דמיטרי · 2 ילדים');
  });

  it('puts the count in the aria-label too', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    expect(profileTrigger().getAttribute('aria-label')).toBe('קורס דמיטרי · 2 ילדים — תפריט');
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
  });

  /**
   * The trigger is NOT gated on `me`: it is the only way into theme and sync,
   * neither of which needs a household, and an avatar that appeared late
   * would undo the fixed-`h-14` no-layout-shift property above.
   */
  it('renders the profile trigger with a placeholder before `me` resolves', () => {
    useMe.mockReturnValue({ data: undefined });
    render(<AppHeader />);

    const trigger = profileTrigger();
    expect(trigger.textContent).toBe('?');
    expect(trigger.getAttribute('aria-label')).toBe('פרופיל — תפריט');
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

  /**
   * One action area at every width. The inline cluster this replaced kept a
   * second live copy of theme, sync and feedback in the DOM -- hidden by
   * Tailwind, but still counted by Playwright's strict mode.
   */
  it('puts every app-wide action behind the one avatar trigger', () => {
    useMe.mockReturnValue({ data: me() });
    const { container } = render(<AppHeader />);

    expect(container.querySelector('[data-testid="app-header-inline"]')).toBeNull();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    expect(screen.queryByTestId('refresh-button')).toBeNull();
    expect(screen.queryByTestId('feedback-launcher-button')).toBeNull();
    expect(screen.getAllByTestId('header-profile-trigger')).toHaveLength(1);
  });

  /**
   * `lg`, not `sm`: the page title moved into this row, and at `sm` a name
   * plus a count plus a title plus four controls is more than 640px holds.
   */
  it('hides the name below lg, where the title owns the row', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<AppHeader />);

    const name = screen.getByText(/קורס דמיטרי · 2 ילדים/);
    expect(name.className).toContain('hidden');
    expect(name.className).toContain('lg:block');
    expect(name.className).not.toContain('sm:block');
  });

  it('carries the title of the section the route is in', () => {
    useMe.mockReturnValue({ data: me() });
    pathname.mockReturnValue('/home');
    render(<AppHeader />);

    expect(screen.getByTestId('app-header-title').textContent).toBe('מרכז הורים');
  });

  it('gives a detail route its section title', () => {
    useMe.mockReturnValue({ data: me() });
    pathname.mockReturnValue('/children/guid-1/homework/hw-1');
    render(<AppHeader />);

    expect(screen.getByTestId('app-header-title').textContent).toBe('ילדים');
  });

  it('renders no title outside the four sections', () => {
    useMe.mockReturnValue({ data: me() });
    pathname.mockReturnValue('/onboarding/connect');
    render(<AppHeader />);

    expect(screen.queryByTestId('app-header-title')).toBeNull();
  });

  /**
   * `useHeaderScroll` marks this header `inert` at the end of the fade. An
   * `<h1>` living here would leave the a11y tree mid-scroll, so the title is
   * an `aria-hidden` span and each page keeps its own `sr-only` heading.
   */
  it('keeps the title out of the a11y tree and out of the heading outline', () => {
    useMe.mockReturnValue({ data: me() });
    render(<AppHeader />);

    const title = screen.getByTestId('app-header-title');
    expect(title.getAttribute('aria-hidden')).toBe('true');
    expect(title.tagName).toBe('SPAN');
  });

  it('shows the unread badge beside the דואר title', () => {
    useMe.mockReturnValue({ data: me() });
    useDashboard.mockReturnValue({ data: { summary: { newConversations: 4 } } });
    pathname.mockReturnValue('/inbox');
    render(<AppHeader />);

    expect(screen.getByText('4')).not.toBeNull();
  });

  /**
   * The title beside it is `aria-hidden`, so without a name of its own the
   * badge is read out as a bare "4".
   */
  it('names what the unread badge counts', () => {
    useMe.mockReturnValue({ data: me() });
    useDashboard.mockReturnValue({ data: { summary: { newConversations: 4 } } });
    pathname.mockReturnValue('/inbox');
    render(<AppHeader />);

    expect(screen.getByLabelText('4 שיחות שלא נקראו')).not.toBeNull();
  });

  it('keeps the unread badge off every other section', () => {
    useMe.mockReturnValue({ data: me() });
    useDashboard.mockReturnValue({ data: { summary: { newConversations: 4 } } });
    pathname.mockReturnValue('/home');
    render(<AppHeader />);

    expect(screen.queryByText('4')).toBeNull();
  });
});
