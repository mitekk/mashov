'use client';

import React from 'react';
import { GraduationCap } from 'lucide-react';
import { useChildSubjects } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableSkeleton } from '@/components/ui/LoadingState';

interface SubjectsSectionProps {
  studentGuid: string;
}

export function SubjectsSection({ studentGuid }: SubjectsSectionProps) {
  const { data, isLoading, isError, refetch } = useChildSubjects(studentGuid);

  return (
    <section data-testid="subjects-section" className="px-4 py-4">
      <h2 className="text-base font-semibold text-foreground mb-3">
        מקצועות לימוד
      </h2>
      {isLoading && <TableSkeleton rows={5} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון מקצועות לימוד"
          onRetry={() => void refetch()}
        />
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<GraduationCap className="w-8 h-8" />}
          title="אין נתוני מקצועות"
        />
      )}
      {data && data.data.length > 0 && (
        <div className="card-base overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
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
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
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
      )}
    </section>
  );
}
