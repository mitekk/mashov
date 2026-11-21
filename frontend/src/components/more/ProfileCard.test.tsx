import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ParentProfile, ProfileChild } from '@/types/api';
import { ProfileCard } from './ProfileCard';

function profile(overrides: Partial<ParentProfile> = {}): ParentProfile {
  return {
    householdConnectionId: 'conn-a',
    upstreamUserId: 'mashov-a',
    displayName: 'קורס דמיטרי',
    email: 'parent@example.com',
    cellphone: '050-1111111',
    schoolName: 'יצחק נבון - צור יצחק (יסודי)',
    schoolYear: 2027,
    schoolCode: 1111,
    detailsState: 2,
    children: [],
    updatedAt: '2026-11-21T09:00:00.000Z',
    ...overrides,
  };
}

function child(overrides: Partial<ProfileChild> = {}): ProfileChild {
  return {
    studentGuid: 'guid-nelly',
    fullName: 'נלי',
    classCode: 'ד',
    classNum: 3,
    ...overrides,
  };
}

describe('ProfileCard', () => {
  // The bug this line exists for: both of a two-school parent's cards read
  // "קורס דמיטרי [מיקה ז8]", because the bracket came from the one global
  // credential name. The children now come from each school's own roster.
  it('lists the school’s children under the school line', () => {
    render(<ProfileCard profile={profile({ children: [child()] })} />);

    expect(screen.getByTestId('profile-card-children').textContent).toBe('נלי ד3');
  });

  it('joins several children with a comma', () => {
    render(
      <ProfileCard
        profile={{
          ...profile(),
          children: [
            child(),
            child({ studentGuid: 'guid-mika', fullName: 'מיקה', classCode: 'ז', classNum: 8 }),
          ],
        }}
      />,
    );

    expect(screen.getByTestId('profile-card-children').textContent).toBe('נלי ד3, מיקה ז8');
  });

  it('renders no children line for a school whose roster has not synced', () => {
    // `[]` is "not known yet", not "no children" -- so the line is absent
    // rather than empty.
    render(<ProfileCard profile={profile({ children: [] })} />);

    expect(screen.queryByTestId('profile-card-children')).toBeNull();
  });

  it('shows the parent name as the API sent it', () => {
    render(<ProfileCard profile={profile({ children: [child()] })} />);

    expect(screen.getByText('קורס דמיטרי')).not.toBeNull();
  });
});
