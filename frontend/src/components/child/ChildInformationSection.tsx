import React from 'react';
import { Clock, Hash, UserCircle2, Users } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';

interface ChildInformationSectionProps {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
}

function getGenderLabel(gender: string): string {
  if (gender === 'M') return 'זכר';
  if (gender === 'F') return 'נקבה';
  return 'לא צוין';
}

export function ChildInformationSection({
  student,
  summary,
  lastSyncAt,
}: ChildInformationSectionProps) {
  return (
    <section data-testid="child-information-section" className="px-4 pt-4">
      <div className="card-base p-4 space-y-3 bg-gradient-to-b from-card to-background/70">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">פרטי תלמיד</h2>
          <span className="chip bg-secondary text-secondary-foreground border border-border">
            {student.isActive ? 'פעיל' : 'לא פעיל'}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <dt className="text-xs text-muted-foreground flex items-center gap-1">
              <UserCircle2 className="w-3.5 h-3.5" />
              שם מלא
            </dt>
            <dd className="text-foreground font-medium mt-1 truncate">{student.fullName}</dd>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <dt className="text-xs text-muted-foreground flex items-center gap-1">
              <Users className="w-3.5 h-3.5" />
              כיתה
            </dt>
            <dd className="text-foreground font-medium mt-1">
              {student.classCode}
              {student.classNum}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <dt className="text-xs text-muted-foreground flex items-center gap-1">
              <Hash className="w-3.5 h-3.5" />
              מגדר
            </dt>
            <dd className="text-foreground font-medium mt-1">{getGenderLabel(student.gender)}</dd>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <dt className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              סנכרון אחרון
            </dt>
            <dd className="text-foreground font-medium mt-1">
              {lastSyncAt ? formatRelativeHe(lastSyncAt) : 'אין מידע'}
            </dd>
          </div>
        </dl>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5">
            <p className="text-[11px] text-blue-700">שיעורי בית (7 ימים)</p>
            <p className="text-sm font-semibold text-blue-900 tabular-nums">
              {summary.recentHomeworkCount}
            </p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
            <p className="text-[11px] text-amber-700">התנהגות (7 ימים)</p>
            <p className="text-sm font-semibold text-amber-900 tabular-nums">
              {summary.recentBehaviorCount}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
            <p className="text-[11px] text-emerald-700">מקצועות</p>
            <p className="text-sm font-semibold text-emerald-900 tabular-nums">
              {summary.subjectCount}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <p className="text-[11px] text-slate-700">שעות שבועיות</p>
            <p className="text-sm font-semibold text-slate-900 tabular-nums">
              {summary.totalWeeklyHours}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
