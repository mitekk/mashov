import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChildStudent, ChildSummary } from '@/types/api';

vi.mock('@/hooks/useChild', () => ({ useSchoolActivities: () => ({ data: [] }) }));
const useChildren = vi.fn(() => ({ data: undefined }) as { data: unknown });
vi.mock('@/hooks/useChildren', () => ({ useChildren: () => useChildren() }));
vi.mock('./ReleasesDialog', () => ({ ReleasesDialog: () => null }));
vi.mock('./SchoolActivitiesDialog', () => ({ SchoolActivitiesDialog: () => null }));

const { ChildHeader } = await import('./ChildHeader');

const student: ChildStudent = {
  studentGuid: 'guid-1',
  fullName: 'מיקה קורס',
  classCode: 'ז',
  classNum: 8,
  isActive: true,
} as ChildStudent;

const summary: ChildSummary = {
  recentHomeworkCount: 0,
  recentBehaviorCount: 0,
  positiveBehaviorCount: 0,
  neutralBehaviorCount: 0,
} as ChildSummary;

function renderHeader() {
  return render(
    <ChildHeader
      student={student}
      summary={summary}
      lastSyncAt={null}
      studentGuid="guid-1"
    />,
  );
}

describe('ChildHeader', () => {
  it('leads with the class, the name being the app header\'s now', () => {
    renderHeader();

    expect(screen.getByText(/כיתה ז8/)).not.toBeNull();
    // The name and the switcher moved into the sticky header; this card
    // repeating them right under it was two header bands stacked.
    expect(screen.queryByTestId('child-header-selector')).toBeNull();
  });

  it('keeps the page heading in the document, hidden', () => {
    // `navigation-fallback.spec.ts` asserts a level-1 heading naming the
    // child, and the header's own title is `aria-hidden` -- so the card still
    // owns the h1, just not a visible one.
    renderHeader();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('מיקה קורס');
    expect(heading.className).toContain('sr-only');
  });

  it('wraps the action buttons on a narrow screen', () => {
    const { container } = renderHeader();
    const actions = container.querySelector('[data-testid="child-header-actions"]');

    expect(actions?.className).toContain('flex-wrap');
  });

  it('lets the identity block shrink so the row can fit', () => {
    const { container } = renderHeader();
    const identity = container.querySelector('[data-testid="child-header-identity"]');

    expect(identity?.className).toContain('min-w-0');
  });
});
