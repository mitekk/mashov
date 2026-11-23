import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useMe = vi.fn();

vi.mock('@/hooks/useAuth', () => ({ useMe: () => useMe() }));

const { SchoolBadge } = await import('./SchoolBadge');

function twoSchools() {
  return { data: { schools: [{ semel: 1 }, { semel: 2 }] } };
}

describe('SchoolBadge', () => {
  beforeEach(() => {
    useMe.mockReturnValue(twoSchools());
  });

  it('shows the short label once the household has two schools', () => {
    render(<SchoolBadge schoolShortLabel="אורט" schoolName="אורט רעננה" />);

    expect(screen.getByTestId('school-badge').textContent).toBe('אורט');
  });

  it('keeps the full name in the tooltip, since the label can be truncated', () => {
    render(<SchoolBadge schoolShortLabel="אורט" schoolName="אורט רעננה" />);

    expect(screen.getByTestId('school-badge').getAttribute('title')).toBe('אורט רעננה');
  });

  it('relaxes the truncation cap as the viewport grows', () => {
    // A hard max-w-[6rem] at every width truncated Hebrew school names on a
    // 1280px desktop that had room for all of them.
    const cls = render(<SchoolBadge schoolShortLabel="אורט" />).container.querySelector(
      '[data-testid="school-badge"]',
    )?.className;

    expect(cls).toContain('max-w-[6rem]');
    expect(cls).toContain('sm:max-w-[10rem]');
    expect(cls).toContain('lg:max-w-none');
  });

  it('renders nothing for a household with one school', () => {
    useMe.mockReturnValue({ data: { schools: [{ semel: 1 }] } });
    const { container } = render(<SchoolBadge schoolShortLabel="אורט" />);

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing without a label', () => {
    const { container } = render(<SchoolBadge schoolShortLabel={null} />);

    expect(container.innerHTML).toBe('');
  });
});
