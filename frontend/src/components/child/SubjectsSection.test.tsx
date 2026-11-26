import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubjectsResponse } from '@/types/api';

const useChildSubjects = vi.fn();
vi.mock('@/hooks/useChild', () => ({
  useChildSubjects: (guid: string) => useChildSubjects(guid) as unknown,
}));

const { SubjectsSection } = await import('./SubjectsSection');

function withData(data: SubjectsResponse | undefined) {
  useChildSubjects.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe('SubjectsSection', () => {
  beforeEach(() => useChildSubjects.mockReset());

  it('explains that the data is not yet published when the only rows are from an earlier year', async () => {
    // The whole point of this section's rework: a child whose school has not
    // published this year's class list must not read as a child who has no
    // classes.
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [2026] } });

    render(<SubjectsSection studentGuid="guid-1" />);

    expect(screen.queryByText('אין נתוני מקצועות')).toBeNull();
    expect(screen.getByText(/עוד לא פורסמו/)).not.toBeNull();
  });

  it('shows the plain empty state when the child has no rows at any year', async () => {
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [] } });

    render(<SubjectsSection studentGuid="guid-1" />);

    expect(screen.getByText('אין נתוני מקצועות')).not.toBeNull();
  });

  it('shows the plain empty state when the backend sent no year metadata', async () => {
    // Deploy skew. Saying nothing is right; inventing a reason is not.
    withData({ data: [] });

    render(<SubjectsSection studentGuid="guid-1" />);

    expect(screen.getByText('אין נתוני מקצועות')).not.toBeNull();
  });

  it('shows the plain empty state when rows exist at the year being served', async () => {
    // Empty with current-year rows present is a filter or an expiry, not a
    // rollover, so the rollover wording would be a lie.
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [2027] } });

    render(<SubjectsSection studentGuid="guid-1" />);

    expect(screen.getByText('אין נתוני מקצועות')).not.toBeNull();
  });

  it('keeps the section testid so the Playwright selectors still resolve', async () => {
    withData({ data: [], meta: { schoolYear: 2027, yearsAvailable: [2026] } });

    render(<SubjectsSection studentGuid="guid-1" />);

    expect(screen.getByTestId('subjects-section')).not.toBeNull();
  });
});
