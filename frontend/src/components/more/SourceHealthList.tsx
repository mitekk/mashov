import React from 'react';
import { CheckCircle, XCircle, AlertCircle, Clock, Loader2 } from 'lucide-react';
import type { SourceHealth, SourceStatus } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface SourceHealthListProps {
  sources?: SourceHealth[];
  /**
   * The base source ids currently being fetched, from `GET /sync/status`.
   * A row in this set spins instead of reporting the status of the run
   * before the one in flight.
   */
  syncingSources?: Set<string>;
}

/**
 * Hebrew name per `sync_run.source` base name.
 *
 * Every id in `backend/src/sync/source-policy.ts`'s `SOURCE_POLICY` needs an
 * entry here: the fallback renders the raw English id, which is what put six
 * of them on screen in English. `SourceHealthList.test.tsx` pins the full id
 * list against that table.
 *
 * `notifications` is deliberately absent, matching `source-policy.ts` — the
 * source no longer exists.
 *
 * Wording is shared with `auth/syncing/SyncingPageClient.tsx`'s `TASK_LABELS`
 * so the two screens name the same thing the same way.
 */
const SOURCE_LABELS: Record<string, string> = {
  mail_counts: 'ספירת הודעות',
  mail_inbox: 'תיבת דואר נכנס',
  homework: 'שיעורי בית',
  behavior: 'התנהגות',
  grades: 'ציונים',
  groups: 'קבוצות',
  lessons_count: 'ספירת שיעורים',
  message_board: 'לוח הודעות',
  achvas: 'קודי התנהגות',
  user_details: 'פרטי משתמש',
  students: 'רשימת תלמידים',
  releases: 'אישורי יציאה',
  // The one camelCase id in the table, and it must stay camelCase: existing
  // `sync_run` rows already carry it.
  schoolActivities: 'פעילויות בית הספר',
  timetable: 'מערכת שעות',
  bells: 'לוח זמנים',
  daily_behave: 'נוכחות יומית',
  out_behave: 'יציאות מהשיעור',
};

/**
 * `every connection failed for <studentGuid> (tried N): <per-connection causes>`
 * — the template ten per-student tasks share. Matching it does two things: it
 * keeps a raw `studentGuid` out of the rendered DOM (the privacy edge
 * `settings.service.ts` flags), and it replaces a long LTR string that Tailwind
 * `truncate` clips from the visually-wrong end inside this RTL document.
 */
const CONNECTION_FAILURE_RE = /^every connection failed for\b/i;

function errorSummary(message: string): string {
  if (CONNECTION_FAILURE_RE.test(message)) return 'לא ניתן היה לגשת לנתוני התלמיד';
  return 'הסנכרון נכשל';
}

const STATUS_PRIORITY: Record<SourceStatus, number> = {
  fresh: 0,
  stale: 1,
  never_synced: 2,
  failed: 3,
};

function StatusIcon({ status }: { status: SourceStatus }) {
  switch (status) {
    case 'fresh':
      return <CheckCircle className="h-4 w-4 text-positive" />;
    case 'stale':
      return <Clock className="h-4 w-4 text-attention" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'never_synced':
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
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

      // Folded from a neutral seed over EVERY entry, rather than from
      // `{...entries[0]}` over the rest. The old seed carried entries[0]'s
      // `lastErrorMessage` through the whole reduce unconditionally — the
      // `status === 'failed'` guard only ever applied to the *incoming* entry
      // — so whenever entries[0] was fresh with an error the backend had not
      // yet marked spent, the row rendered a green `תקין`, a relative time
      // taken from another child's success, and that error, all on one line.
      // A departed child's key is exactly that shape and never stops being
      // it: nothing will ever sync her again, so no later success can
      // supersede her last failure.
      const merged = entries.reduce<{
        status: SourceStatus;
        lastSuccessAt: string | null;
        lastAttemptAt: string | null;
        errorFrom: SourceHealth | null;
      }>(
        (combined, current) => ({
          status: selectWorseStatus(combined.status, current.status),
          lastSuccessAt: maxIsoDate(combined.lastSuccessAt, current.lastSuccessAt),
          lastAttemptAt: maxIsoDate(combined.lastAttemptAt, current.lastAttemptAt),
          // The error belongs to the entry whose status is the worst one
          // carrying one, so the message and the icon describe the same run.
          errorFrom:
            current.lastErrorMessage &&
            (!combined.errorFrom ||
              STATUS_PRIORITY[current.status] > STATUS_PRIORITY[combined.errorFrom.status])
              ? current
              : combined.errorFrom,
        }),
        { status: 'fresh', lastSuccessAt: null, lastAttemptAt: null, errorFrom: null },
      );

      // Suppressed only on a merged `fresh`: every contributing entry is then
      // fresh, and the backend reaches the same verdict for the bare key via
      // `errorIsSpent`. Deliberately not `status !== 'failed'` — a
      // stale-but-failing source is the row most worth reading, the rule
      // `freshness.service.ts` already states.
      const lastErrorMessage =
        merged.status === 'fresh' ? null : merged.errorFrom?.lastErrorMessage ?? null;

      return {
        source: baseSource,
        status: merged.status,
        lastSuccessAt: merged.lastSuccessAt,
        lastAttemptAt: merged.lastAttemptAt,
        lastErrorMessage,
        fetchedCount: null,
        staleThresholdMinutes: entries[0].staleThresholdMinutes,
      };
    });
}

export function SourceHealthList({ sources, syncingSources }: SourceHealthListProps) {
  const safeSources = normalizeSources(sources ?? []);

  return (
    <div data-testid="source-health-list" className="card-base divide-y divide-border">
      {safeSources.map((source) => {
        const isSyncing = syncingSources?.has(source.source) ?? false;

        return (
          <div key={source.source} className="flex items-center gap-3 px-4 py-3">
            {isSyncing ? (
              <Loader2
                data-testid={`source-syncing-${source.source}`}
                aria-hidden
                className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
              />
            ) : (
              <StatusIcon status={source.status} />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {SOURCE_LABELS[source.source] ?? source.source}
              </p>
              {/* Suppressed while the row is syncing: the error describes the
                  run BEFORE the one in flight. */}
              {source.lastErrorMessage && !isSyncing && (
                <p
                  className="text-xs text-destructive truncate mt-0.5"
                  // The raw technical string stays reachable for debugging
                  // without ever being rendered as text.
                  title={source.lastErrorMessage}
                >
                  {errorSummary(source.lastErrorMessage)}
                </p>
              )}
            </div>
            <div className="text-end flex-shrink-0">
              <p className={cn(
                'text-xs font-medium',
                source.status === 'fresh' && 'text-positive',
                source.status === 'stale' && 'text-attention',
                source.status === 'failed' && 'text-destructive',
                source.status === 'never_synced' && 'text-muted-foreground',
                isSyncing && 'text-muted-foreground',
              )}>
                {isSyncing ? 'מסנכרן…' : statusLabel(source.status)}
              </p>
              {source.lastSuccessAt && (
                <p className="text-xs text-muted-foreground">
                  {formatRelativeHe(source.lastSuccessAt)}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
