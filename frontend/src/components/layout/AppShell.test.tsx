import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useAuth', () => ({
  useMe: () => ({ data: { mashovUserId: 'm1', username: 'p', displayName: 'הורה', childrenCount: 1, schools: [] } }),
}));
vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));
vi.mock('@/hooks/useDashboard', () => ({
  useSyncRefresh: () => ({ mutate: vi.fn(), isPending: false }),
  useDashboard: () => ({ data: { freshness: { state: 'degraded' } } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('./AppNav', () => ({ AppNav: () => <nav data-testid="bottom-nav" /> }));
// Needs a mounted app router and the child list; it has its own suite.
vi.mock('./HeaderChildSwitcher', () => ({ HeaderChildSwitcher: () => null }));

const { AppShell } = await import('./AppShell');

describe('AppShell', () => {
  /**
   * `pt-safe` has exactly one owner: the header. It used to sit on the wrapper,
   * which does nothing once a `sticky top-0` child parks at the viewport top.
   *
   * The freshness banner is the reason this ordering matters. While it renders
   * -- the `degraded` and `stale` states -- anything ABOVE the header either
   * sits under the notch itself or forces a second copy of the inset, giving a
   * ~47px blank strip inside the header on an iPhone. Putting the header first
   * makes the question disappear: the header is always the topmost chrome, and
   * the banner scrolls away beneath it.
   */
  it('puts the header above the freshness banner in the document', () => {
    const { container } = render(<AppShell>content</AppShell>);

    const header = screen.getByTestId('app-header');
    // By text, not by role: the feedback provider mounts a `role="status"`
    // live region too, and this is about the stale-sync banner.
    const banner = screen.getByText(/הנתונים עשויים להיות ישנים/);

    expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('.pt-safe')).toHaveLength(1);
    expect(header.className).toContain('pt-safe');
  });

  it('leaves the notch padding to the header when no banner is showing', () => {
    const { container } = render(<AppShell>content</AppShell>);

    // Whatever the freshness state, exactly one element carries the inset.
    expect(container.querySelectorAll('.pt-safe')).toHaveLength(1);
  });
});
