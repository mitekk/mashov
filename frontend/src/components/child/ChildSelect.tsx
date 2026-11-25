'use client';

import React, { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/Select';

export interface ChildOption {
  studentGuid: string;
  fullName: string;
  isActive: boolean;
  /** Used to group the list once a household has more than one school. */
  schoolId?: string | null;
  schoolShortLabel?: string | null;
}

/**
 * Kept as an alias of `ChildOption` so the name `ChildHeader` introduced keeps
 * resolving for callers and tests that already import it.
 */
export type ChildHeaderOption = ChildOption;

interface ChildSelectProps {
  options: ChildOption[];
  value: string;
  onChange: (studentGuid: string) => void;
  triggerClassName?: string;
}

/**
 * One group per distinct school, in the order the options arrive, so the
 * grouping is stable between renders.
 */
export function groupOptionsBySchool(
  options: ChildOption[],
): Array<{ key: string; label: string; children: ChildOption[] }> {
  const groups: Array<{ key: string; label: string; children: ChildOption[] }> = [];
  for (const child of options) {
    const key = child.schoolId ?? '__unowned__';
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.children.push(child);
    else
      groups.push({
        key,
        label: child.schoolShortLabel ?? 'בית ספר',
        children: [child],
      });
  }
  return groups;
}

/**
 * The child picker itself: a Radix `Select`, grouped by school only once a
 * household has more than one.
 *
 * Lifted out of `ChildHeader` when the title and the switcher moved into the
 * app header. The trigger carries no styling of its own -- `triggerClassName`
 * is the whole of it -- because its two homes are a hero card and a 56px
 * header row.
 */
export function ChildSelect({
  options,
  value,
  onChange,
  triggerClassName,
}: ChildSelectProps) {
  const schoolGroups = useMemo(() => groupOptionsBySchool(options), [options]);
  const selectedName =
    options.find((child) => child.studentGuid === value)?.fullName ?? '';

  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={options.length === 0}
      dir="rtl"
    >
      <SelectTrigger
        id="child-header-selector"
        aria-label="בחר ילד"
        data-testid="child-header-selector"
        className={triggerClassName}
      >
        <span className="truncate">{selectedName}</span>
      </SelectTrigger>
      <SelectContent align="start" className="max-h-72">
        <div className="space-y-1">
          {/* Grouped only above one distinct school. With one, this is
              byte-for-byte the flat list it has always been, which is
              why children.spec.ts needs no change. */}
          {schoolGroups.length > 1
            ? schoolGroups.map((group) => (
                <SelectGroup key={group.key}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.children.map((child) => (
                    <SelectItem
                      key={child.studentGuid}
                      value={child.studentGuid}
                      className="text-base"
                    >
                      {child.fullName}
                      {child.isActive ? '' : ' (לא פעיל)'}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))
            : options.map((child) => (
                <SelectItem
                  key={child.studentGuid}
                  value={child.studentGuid}
                  className="text-base"
                >
                  {child.fullName}
                  {child.isActive ? '' : ' (לא פעיל)'}
                </SelectItem>
              ))}
        </div>
      </SelectContent>
    </Select>
  );
}
