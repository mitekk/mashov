'use client';

import React from 'react';
import { GraduationCap } from 'lucide-react';
import { useChildSubjects } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableSkeleton } from '@/components/ui/LoadingState';
import { holdsOnlyEarlierYears } from './section-emptiness';

interface SubjectsSectionProps {
  studentGuid: string;
}

export function SubjectsSection({ studentGuid }: SubjectsSectionProps) {
  const { data, isLoading, isError, refetch } = useChildSubjects(studentGuid);

  return (
    <section
      data-testid="subjects-section"
      // The tab rail above already names this section, so the heading is
      // `sr-only` -- the outline needs it, the eye does not.
      // `aria-labelledby` rather than `aria-label`: the two would otherwise
      // announce the same name twice, once as the region and once as the
      // heading.
      aria-labelledby="subjects-section-title"
      className="section-stack py-1"
    >
      <h2 id="subjects-section-title" className="sr-only">מקצועות לימוד</h2>
      {isLoading && <TableSkeleton rows={5} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון מקצועות לימוד"
          onRetry={() => void refetch()}
        />
      )}
      {/* Two different empty states, because they mean different things. A
          child whose school has not published this year's class list yet is
          not a child without classes, and telling them "אין נתוני מקצועות"
          asserts something we do not know. We keep last year's rows in the
          database but deliberately do not serve them as if they were current,
          so saying so is the honest option. */}
      {data && data.data.length === 0 && !holdsOnlyEarlierYears(data.meta) && (
        <EmptyState
          icon={<GraduationCap className="w-8 h-8" />}
          title="אין נתוני מקצועות"
        />
      )}
      {data && data.data.length === 0 && holdsOnlyEarlierYears(data.meta) && (
        <EmptyState
          icon={<GraduationCap className="w-8 h-8" />}
          title="המקצועות לשנה הנוכחית עוד לא פורסמו"
          subtitle="הנתונים שיש לנו הם משנת הלימודים הקודמת, ולכן לא מוצגים כאן. הרשימה תתעדכן כשבית הספר יפרסם אותה."
        />
      )}
      {/* The card clips, so the table needs its own scroller: a long teacher
          name should scroll inside the card rather than be cut off by it. A
          two-column grid, which the other sections get at lg, would make no
          sense for a single table. */}
      {data && data.data.length > 0 && (
        <div className="card-base overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/55">
                <th className="text-start px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                  מקצוע
                </th>
                <th className="text-start px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                  מורה
                </th>
                <th className="text-end px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                  ש&quot;ש
                </th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((subject) => {
                const activeTeacher = subject.teachers[0];
                return (
                  <tr
                    key={subject.id}
                    className="border-b border-border last:border-0 transition-colors hover:bg-accent/45"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {subject.subjectName}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {activeTeacher ? activeTeacher.teacherName : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-end tabular-nums">
                      {subject.weeklyHours}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </section>
  );
}
