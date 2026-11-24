'use client';

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSchools } from '@/api/auth';
import type { School } from '@/types/api';

interface SchoolAutocompleteProps {
  value: School | null;
  onSelect: (school: School) => void;
  /**
   * Called when the typed text no longer matches the selected school.
   *
   * Without it, editing the text after picking a school would leave the
   * selection in place and submit a school the input is no longer showing.
   */
  onClear?: () => void;
  inputTestId: string;
  /** Rendered as `{prefix}-{semel}` on each option. */
  optionTestIdPrefix: string;
  /** Schools already connected: shown, but unselectable. */
  disabledSemels?: number[];
  /** Why a disabled school cannot be picked. */
  disabledHint?: string;
  label?: string;
  placeholder?: string;
}

/**
 * The school picker, extracted from the sign-in form so linking a second
 * school uses the same one.
 *
 * `role="option"` is kept on each item because `AuthPage.selectSchoolOption`
 * selects by role; `data-testid="{prefix}-{semel}"` is added alongside it so a
 * test can name a specific school rather than an index.
 *
 * Already-linked schools render disabled rather than being filtered out:
 * preventing the error beats reporting it, and a parent looking for a school
 * they have already added needs to see that it is there, not conclude the
 * search is broken.
 */
export function SchoolAutocomplete({
  value,
  onSelect,
  onClear,
  inputTestId,
  optionTestIdPrefix,
  disabledSemels = [],
  disabledHint = 'מחובר כבר',
  label = 'בית ספר',
  placeholder = 'חפש בית ספר...',
}: SchoolAutocompleteProps) {
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const { data: schools = [] } = useQuery({
    queryKey: ['schools'],
    queryFn: getSchools,
    staleTime: 10 * 60_000,
  });

  const filteredSchools = useMemo(() => {
    if (!search.trim()) return schools.slice(0, 50);
    const q = search.toLowerCase();
    return schools
      .filter((s) => s.name.toLowerCase().includes(q) || String(s.semel).includes(q))
      .slice(0, 50);
  }, [schools, search]);

  const disabled = useMemo(() => new Set(disabledSemels), [disabledSemels]);
  const inputId = `${inputTestId}-input`;

  return (
    <div className="relative space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        data-testid={inputTestId}
        autoComplete="off"
        placeholder={placeholder}
        value={search || value?.name || ''}
        onChange={(event) => {
          setSearch(event.target.value);
          setShowDropdown(true);
          if (value && event.target.value !== value.name) onClear?.();
        }}
        onFocus={() => setShowDropdown(true)}
        // Delayed, so a mousedown on an option still lands before the list
        // unmounts.
        onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
        className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
      />
      {showDropdown && filteredSchools.length > 0 && (
        <ul
          className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg"
          role="listbox"
        >
          {filteredSchools.map((school) => {
            const isDisabled = disabled.has(school.semel);
            return (
              <li
                key={school.semel}
                role="option"
                aria-selected={value?.semel === school.semel}
                aria-disabled={isDisabled || undefined}
                data-testid={`${optionTestIdPrefix}-${school.semel}`}
                onMouseDown={() => {
                  if (isDisabled) return;
                  setSearch('');
                  onSelect(school);
                }}
                className={
                  isDisabled
                    ? 'px-3 py-2.5 text-sm text-muted-foreground cursor-not-allowed opacity-60'
                    : 'cursor-pointer px-3 py-2.5 text-sm text-popover-foreground hover:bg-accent transition-colors'
                }
              >
                <span className="font-medium">{school.name}</span>
                <span className="ms-2 text-xs text-muted-foreground">{school.semel}</span>
                {isDisabled && (
                  <span className="ms-2 text-xs text-muted-foreground">({disabledHint})</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
