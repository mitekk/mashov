'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { useMe } from '@/hooks/useAuth';
import { ALL_SCHOOLS, type SchoolFilter } from '@/lib/school-filter';

interface SchoolFilterChipsProps {
  value: SchoolFilter;
  onChange: (filter: SchoolFilter) => void;
}

/**
 * Filter a cross-child surface down to one school.
 *
 * Renders `null` below two connected schools: a single chip row offering one
 * school plus "all" is noise, and keeping the DOM unchanged for a one-school
 * household is what lets every existing e2e spec stay as written.
 *
 * Horizontally scrollable rather than wrapping. Mashov school names are long
 * and a wrapped chip row on a 360px screen pushes the content it filters off
 * the first viewport.
 */
export function SchoolFilterChips({ value, onChange }: SchoolFilterChipsProps) {
  const { data: me } = useMe();
  const schools = me?.schools ?? [];

  if (schools.length < 2) return null;

  return (
    <div
      role="group"
      aria-label="סינון לפי בית ספר"
      data-testid="school-filter-chips"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Chip
        testId="school-filter-chip-all"
        label="כל בתי הספר"
        isActive={value === ALL_SCHOOLS}
        onClick={() => onChange(ALL_SCHOOLS)}
      />
      {schools.map((school) => (
        <Chip
          key={school.semel}
          testId={`school-filter-chip-${school.semel}`}
          label={school.shortLabel}
          title={school.schoolName}
          isActive={value === school.semel}
          onClick={() => onChange(school.semel)}
        />
      ))}
    </div>
  );
}

function Chip({
  testId,
  label,
  title,
  isActive,
  onClick,
}: {
  testId: string;
  label: string;
  title?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      // `aria-pressed`, not `aria-selected`: these are toggle buttons in a
      // group, not options in a listbox.
      aria-pressed={isActive}
      title={title}
      onClick={onClick}
      className={cn(
        'chip flex-shrink-0 whitespace-nowrap transition-colors',
        isActive
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'hover:bg-secondary',
      )}
    >
      {label}
    </button>
  );
}
