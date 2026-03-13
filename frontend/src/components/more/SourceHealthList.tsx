import React from 'react';
import { CheckCircle, XCircle, AlertCircle, Clock } from 'lucide-react';
import type { SourceHealth, SourceStatus } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface SourceHealthListProps {
  sources?: SourceHealth[];
}

const SOURCE_LABELS: Record<string, string> = {
  notifications: 'התראות',
  mail_counts: 'ספירת הודעות',
  mail_inbox: 'תיבת דואר נכנס',
  homework: 'שיעורי בית',
  behavior: 'התנהגות',
  groups: 'קבוצות',
  lessons_count: 'ספירת שיעורים',
  message_board: 'לוח הודעות',
  achvas: 'קודי התנהגות',
  user_details: 'פרטי משתמש',
};

const STATUS_PRIORITY: Record<SourceStatus, number> = {
  fresh: 0,
  stale: 1,
  never_synced: 2,
  failed: 3,
};

function StatusIcon({ status }: { status: SourceStatus }) {
  switch (status) {
    case 'fresh':
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case 'stale':
      return <Clock className="w-4 h-4 text-amber-500" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-destructive" />;
    case 'never_synced':
      return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
    default:
      return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
  }
}

function statusLabel(status: SourceStatus): string {
  switch (status) {
    case 'fresh': return 'תקין';
    case 'stale': return 'ישן';
    case 'failed': return 'שגיאה';
    case 'never_synced': return 'לא סונכרן';
    default: return 'לא ידוע';
  }
}

function getBaseSource(source: string): string {
  const separatorIndex = source.indexOf(':');
  return separatorIndex >= 0 ? source.slice(0, separatorIndex) : source;
}

function selectWorseStatus(current: SourceStatus, next: SourceStatus): SourceStatus {
  return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
}

function maxIsoDate(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return new Date(first) >= new Date(second) ? first : second;
}

function normalizeSources(sources: SourceHealth[]): SourceHealth[] {
  const groups = new Map<
    string,
    {
      firstIndex: number;
      baseEntries: SourceHealth[];
      scopedEntries: SourceHealth[];
    }
  >();

  sources.forEach((entry, index) => {
    const baseSource = getBaseSource(entry.source);
    const group = groups.get(baseSource) ?? {
      firstIndex: index,
      baseEntries: [],
      scopedEntries: [],
    };

    if (entry.source.includes(':')) {
      group.scopedEntries.push(entry);
    } else {
      group.baseEntries.push(entry);
    }

    groups.set(baseSource, group);
  });

  return Array.from(groups.entries())
    .sort(([, a], [, b]) => a.firstIndex - b.firstIndex)
    .map(([baseSource, group]) => {
      const entries = group.scopedEntries.length > 0 ? group.scopedEntries : group.baseEntries;
      const initial = entries[0];

      return entries.slice(1).reduce<SourceHealth>(
        (combined, current) => {
          const status = selectWorseStatus(combined.status, current.status);
          const latestSuccessAt = maxIsoDate(combined.lastSuccessAt, current.lastSuccessAt);
          const latestAttemptAt = maxIsoDate(combined.lastAttemptAt, current.lastAttemptAt);
          const lastErrorMessage =
            status === 'failed'
              ? current.lastErrorMessage ?? combined.lastErrorMessage
              : combined.lastErrorMessage;

          return {
            source: baseSource,
            status,
            lastSuccessAt: latestSuccessAt,
            lastAttemptAt: latestAttemptAt,
            lastErrorMessage,
            fetchedCount: null,
            staleThresholdMinutes: combined.staleThresholdMinutes,
          };
        },
        {
          ...initial,
          source: baseSource,
        },
      );
    });
}

export function SourceHealthList({ sources }: SourceHealthListProps) {
  const safeSources = normalizeSources(sources ?? []);

  return (
    <div data-testid="source-health-list" className="card-base divide-y divide-border">
      {safeSources.map((source) => (
        <div key={source.source} className="flex items-center gap-3 px-4 py-3">
          <StatusIcon status={source.status} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {SOURCE_LABELS[source.source] ?? source.source}
            </p>
            {source.lastErrorMessage && (
              <p className="text-xs text-destructive truncate mt-0.5">
                {source.lastErrorMessage}
              </p>
            )}
          </div>
          <div className="text-end flex-shrink-0">
            <p className={cn(
              'text-xs font-medium',
              source.status === 'fresh' && 'text-green-600',
              source.status === 'stale' && 'text-amber-600',
              source.status === 'failed' && 'text-destructive',
              source.status === 'never_synced' && 'text-muted-foreground',
            )}>
              {statusLabel(source.status)}
            </p>
            {source.lastSuccessAt && (
              <p className="text-xs text-muted-foreground">
                {formatRelativeHe(source.lastSuccessAt)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
