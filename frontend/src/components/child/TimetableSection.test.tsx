import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimetableResponse } from '@/types/api';

const useChildTimetable = vi.fn();
vi.mock('@/hooks/useChild', () => ({
  useChildTimetable: (guid: string) => useChildTimetable(guid) as unknown,
  useChildLessonPlans: () => ({ data: { data: [] } }),
  useChildLessonHistory: () => ({ data: { data: [] } }),
}));
vi.mock('./TimetableDayAgenda', () => ({ TimetableDayAgenda: () => null }));
vi.mock('./TimetableWeekGrid', () => ({ TimetableWeekGrid: () => null }));

const { TimetableSection } = await import('./TimetableSection');

function withData(data: TimetableResponse | undefined) {
  useChildTimetable.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe('TimetableSection', () => {
  beforeEach(() => useChildTimetable.mockReset());

  it('explains that the data is not yet published when the only rows are from an earlier year', async () => {
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [2026] } });

    render(<TimetableSection studentGuid="guid-1" />);

    expect(screen.queryByText('לא נמצא לוח שיעורים')).toBeNull();
    expect(screen.getByText(/עוד לא פורסם/)).not.toBeNull();
  });

  it('shows the plain empty state when the child has no rows at any year', async () => {
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [] } });

    render(<TimetableSection studentGuid="guid-1" />);

    expect(screen.getByText('לא נמצא לוח שיעורים')).not.toBeNull();
  });

  it('shows the plain empty state when the backend sent no year metadata', async () => {
    withData({ data: [] });

    render(<TimetableSection studentGuid="guid-1" />);

    expect(screen.getByText('לא נמצא לוח שיעורים')).not.toBeNull();
  });

  it('treats a pre-migration year 0 row as served, not as last year', async () => {
    // `UNSCOPED_SCHOOL_YEAR` is admitted by the backend's own year scope, so
    // claiming it is last year's would contradict what we just served.
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [0] } });

    render(<TimetableSection studentGuid="guid-1" />);

    expect(screen.getByText('לא נמצא לוח שיעורים')).not.toBeNull();
  });
});
