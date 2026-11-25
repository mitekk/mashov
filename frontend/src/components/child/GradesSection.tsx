'use client';

import React from 'react';
import { ClipboardList } from 'lucide-react';
import { useChildGrades } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableSkeleton } from '@/components/ui/LoadingState';
import { Badge } from '@/components/ui/Badge';
import { formatShortDate } from '@/lib/dates';
import { gradeBandVariant } from '@/lib/grades';
import { groupGradesBySubject } from './grades-model';

interface GradesSectionProps {
  studentGuid: string;
}

/** A missing or unusable number reads as an em dash, never as "NaN". */
function renderGrade(grade: number): string {
  return Number.isFinite(grade) ? String(grade) : '—';
}

export function GradesSection({ studentGuid }: GradesSectionProps) {
  const { data, isLoading, isError, refetch } = useChildGrades(studentGuid);

  // Memoised on the fetched rows: the grouping and the averages are pure, and
  // recomputing them on every unrelated re-render of the workspace is work
  // nobody asked for.
  const groups = React.useMemo(
    () => groupGradesBySubject(data?.data ?? []),
    [data?.data],
  );

  return (
    <section
      data-testid="grades-section"
      // The tab rail above already names this section, so the heading is
      // `sr-only` -- the outline needs it, the eye does not.
      aria-labelledby="grades-section-title"
      className="section-stack py-1"
    >
      <h2 id="grades-section-title" className="sr-only">ציונים</h2>
      {isLoading && <TableSkeleton rows={5} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון ציונים"
          onRetry={() => void refetch()}
        />
      )}
      {data && groups.length === 0 && (
        <EmptyState
          icon={<ClipboardList className="w-8 h-8" />}
          title="אין ציונים"
        />
      )}
      {data &&
        groups.map((group) => (
          <div
            key={group.subjectName}
            data-testid={`grades-subject-${group.groupId}`}
            className="card-base overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/55 px-4 py-2.5">
              <h3 className="text-sm font-semibold text-foreground text-start">
                {group.subjectName}
              </h3>
              <span
                data-testid={`grades-subject-average-${group.groupId}`}
                className="text-xs text-muted-foreground tabular-nums whitespace-nowrap"
              >
                ממוצע {group.average === null ? '—' : group.average}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {group.grades.map((grade) => (
                <li
                  key={grade.id}
                  data-testid={`grades-item-${grade.id}`}
                  className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent/45"
                >
                  <div className="min-w-0 space-y-1 text-start">
                    <p className="text-sm font-medium text-foreground break-words">
                      {grade.gradingEvent || '—'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {grade.gradeType && (
                        <Badge variant="neutral">{grade.gradeType}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatShortDate(grade.eventDate) || '—'}
                      </span>
                    </div>
                  </div>
                  <Badge
                    variant={gradeBandVariant(grade.grade)}
                    size="md"
                    className="tabular-nums shrink-0"
                  >
                    {renderGrade(grade.grade)}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
