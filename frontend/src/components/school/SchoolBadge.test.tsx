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

  it('carries a truncation cap that relaxes at sm and lifts at lg', () => {
    // A class-string check, not a rendered-width one: jsdom applies no
    // stylesheet, so nothing here can observe the truncation itself. The
    // widths are measured at 360/768/1280 by the overflow sweep in
    // tests/e2e/responsive.spec.ts. What this pins is that the cap is
    // viewport-dependent at all -- a hard max-w-[6rem] truncated Hebrew
    // school names on a desktop with room for all of them.
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
