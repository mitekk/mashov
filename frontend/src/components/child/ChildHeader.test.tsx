import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChildStudent, ChildSummary } from '@/types/api';
import type { ChildHeaderOption } from './ChildHeader';

vi.mock('@/hooks/useChild', () => ({ useSchoolActivities: () => ({ data: [] }) }));
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

function options(count: number): ChildHeaderOption[] {
  return Array.from({ length: count }, (_, i) => ({
    studentGuid: `guid-${i + 1}`,
    fullName: `ילד ${i + 1}`,
    isActive: true,
  }));
}

function renderHeader(childOptions = options(2)) {
  return render(
    <ChildHeader
      student={student}
      summary={summary}
      lastSyncAt={null}
      childOptions={childOptions}
      selectedChildGuid="guid-1"
      onChildChange={vi.fn()}
      studentGuid="guid-1"
    />,
  );
}

describe('ChildHeader', () => {
  it('names the selected child and the class', () => {
    renderHeader();

    expect(screen.getByTestId('child-header-selector').textContent).toContain('מיקה קורס');
    expect(screen.getByText(/כיתה ז8/)).not.toBeNull();
  });

  it('lets the child selector shrink below its preferred width', () => {
    // At 360 the row was a title plus a 20rem select plus four 40px icon
    // buttons inside `card-base px-4` -- ~296px of usable width for ~480px of
    // content. `max-w-xs` is a floor-less cap: `min(100%, …)` is the cap that
    // actually yields.
    renderHeader();
    const trigger = screen.getByTestId('child-header-selector');

    expect(trigger.className).toContain('max-w-[min(100%,20rem)]');
    expect(trigger.className).not.toContain('max-w-xs');
  });

  it('truncates a long child name rather than widening the row', () => {
    renderHeader();

    const name = screen.getByText('מיקה קורס');
    expect(name.className).toContain('truncate');
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
