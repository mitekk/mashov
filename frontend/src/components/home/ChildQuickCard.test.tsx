import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardChildCard } from '@/types/api';

const getPhase1HrefOrNull = vi.fn<(href: string) => string | null>();

vi.mock('@/hooks/useSelectedChild', () => ({
  useSelectedChild: () => ({ setSelectedChildGuid: vi.fn() }),
}));
vi.mock('@/lib/phase1-routes', () => ({
  getPhase1HrefOrNull: (href: string) => getPhase1HrefOrNull(href),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

const { ChildQuickCard } = await import('./ChildQuickCard');

function child(overrides: Partial<DashboardChildCard> = {}): DashboardChildCard {
  return {
    studentGuid: 'guid-1',
    fullName: 'מיקה קורס',
    classCode: 'ז',
    classNum: 8,
    recentHomeworkCount: 2,
    recentBehaviorCount: 1,
    positiveBehaviorCount: 3,
    neutralBehaviorCount: 0,
    latestUpdateAt: null,
    ...overrides,
  } as DashboardChildCard;
}

function cardClassName(): string {
  return screen.getByTestId('child-card-guid-1').className;
}

describe('ChildQuickCard', () => {
  beforeEach(() => {
    getPhase1HrefOrNull.mockImplementation((href) => href);
  });

  it('names the child and the class', () => {
    render(<ChildQuickCard child={child()} />);

    expect(screen.getByTestId('child-card-guid-1').textContent).toContain('מיקה קורס');
    expect(screen.getByTestId('child-card-guid-1').textContent).toContain('כיתה ז8');
  });

  it('holds a rail-width floor on a phone', () => {
    // The rail scrolls horizontally below md, and a card narrower than this
    // wraps the name onto three lines.
    render(<ChildQuickCard child={child()} />);

    expect(cardClassName()).toContain('min-w-[176px]');
  });

  it('drops the rail floor from md up, where the cards become a grid', () => {
    // This has to live on the card's own className, not on a parent component
    // class: @layer components always loses to @layer utilities, so a
    // `.card-grid` rule could never override `min-w-[176px]` from here.
    render(<ChildQuickCard child={child()} />);

    expect(cardClassName()).toContain('md:min-w-0');
    expect(cardClassName()).toContain('md:w-auto');
    expect(cardClassName()).toContain('md:flex-shrink');
  });

  it('applies the same sizing to the phase-1-gated variant', () => {
    // Gating renders a <div> instead of a <Link>; the two must not drift, or a
    // gated child breaks the grid row it sits in.
    getPhase1HrefOrNull.mockReturnValue(null);
    render(<ChildQuickCard child={child()} />);

    const gated = screen.getByTestId('child-card-disabled-guid-1').className;
    expect(gated).toContain('min-w-[176px]');
    expect(gated).toContain('md:min-w-0');
    expect(gated).toContain('md:w-auto');
  });
});
