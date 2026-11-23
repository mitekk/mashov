import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useDashboard = vi.fn();
const usePathname = vi.fn();

vi.mock('@/hooks/useDashboard', () => ({ useDashboard: () => useDashboard() }));
vi.mock('next/navigation', () => ({ usePathname: () => usePathname() }));
// `next/link` renders an anchor without the app router in the tree.
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

const { AppNav } = await import('./AppNav');
const { NAV_ITEMS } = await import('./navItems');

function dashboard(newConversations: number) {
  return { data: { summary: { newConversations } } };
}

describe('NAV_ITEMS', () => {
  it('is the four top-level destinations, in order', () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      '/home',
      '/children',
      '/inbox',
      '/more',
    ]);
  });

  it('keeps the testids the e2e suite addresses', () => {
    expect(NAV_ITEMS.map((item) => item.testId)).toEqual([
      'nav-home',
      'nav-children',
      'nav-inbox',
      'nav-more',
    ]);
  });
});

describe('AppNav', () => {
  beforeEach(() => {
    useDashboard.mockReturnValue(dashboard(0));
    usePathname.mockReturnValue('/home');
  });

  it('renders one nav landmark, keyed by the bottom-nav testid', () => {
    render(<AppNav />);

    // A second presentation (bottom bar + side rail) would resolve this twice
    // and break Playwright's strict mode, so there is exactly one node.
    expect(screen.getAllByTestId('bottom-nav')).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
  });

  it('renders each destination exactly once', () => {
    render(<AppNav />);

    for (const item of NAV_ITEMS) {
      expect(screen.getAllByTestId(item.testId)).toHaveLength(1);
    }
  });

  it('marks the current section with aria-current', () => {
    usePathname.mockReturnValue('/children/abc-123');
    render(<AppNav />);

    expect(screen.getByTestId('nav-children').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-home').getAttribute('aria-current')).toBeNull();
  });

  it('renders the unread count as text inside the inbox link', () => {
    // school-filter.spec.ts asserts nav-inbox toContainText('64') at 1280, so
    // the count must be readable text at every width -- never a bare dot.
    useDashboard.mockReturnValue(dashboard(64));
    render(<AppNav />);

    expect(screen.getByTestId('nav-inbox').textContent).toContain('64');
  });

  it('caps the unread count at 99+', () => {
    useDashboard.mockReturnValue(dashboard(240));
    render(<AppNav />);

    expect(screen.getByTestId('nav-inbox').textContent).toContain('99+');
  });

  it('shows no count when the inbox has nothing new', () => {
    useDashboard.mockReturnValue(dashboard(0));
    render(<AppNav />);

    expect(screen.getByTestId('nav-inbox').textContent).not.toMatch(/\d/);
  });

  it('survives a dashboard that has not loaded', () => {
    useDashboard.mockReturnValue({ data: undefined });
    render(<AppNav />);

    expect(screen.getByTestId('nav-inbox').textContent).not.toMatch(/\d/);
  });

  it('keeps every destination a tap target at phone width', () => {
    render(<AppNav />);

    for (const item of NAV_ITEMS) {
      expect(screen.getByTestId(item.testId).className).toContain('tap-target');
    }
  });
});
