import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppUser } from '@/types/api';

const useMe = vi.fn();

vi.mock('@/hooks/useAuth', () => ({ useMe: () => useMe() }));
// `next/link` renders an anchor without the app router in the tree.
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

const { UserHeader } = await import('./UserHeader');

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

function headerText(): string {
  return screen.getByRole('link').textContent ?? '';
}

describe('UserHeader', () => {
  it('names no children when the household has none', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 0 }) });
    render(<UserHeader />);

    expect(headerText()).toBe('קורס דמיטריקד');
  });

  it('says ילד אחד for one child', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 1 }) });
    render(<UserHeader />);

    expect(headerText()).toContain('קורס דמיטרי · ילד אחד');
  });

  it('counts children in the plural', () => {
    // The two-school case the whole change is for: the header used to read
    // "קורס דמיטרי [מיקה ז8]" -- one school's child above every school's
    // content.
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<UserHeader />);

    expect(headerText()).toContain('קורס דמיטרי · 2 ילדים');
  });

  it('puts the count in the aria-label too', () => {
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<UserHeader />);

    expect(screen.getByRole('link').getAttribute('aria-label')).toBe(
      'קורס דמיטרי · 2 ילדים — הגדרות',
    );
  });

  it('takes initials from the stripped name', () => {
    // `getInitials` runs on what the API sends. Stripped, "קורס דמיטרי" gives
    // קד; with the bracket still attached it gave the child's initial.
    useMe.mockReturnValue({ data: me({ childrenCount: 2 }) });
    render(<UserHeader />);

    expect(screen.getByText('קד')).not.toBeNull();
  });

  it('renders nothing before `me` has loaded', () => {
    useMe.mockReturnValue({ data: undefined });
    const { container } = render(<UserHeader />);

    expect(container.innerHTML).toBe('');
  });
});
