import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PER_STUDENT_SOURCES } from './freshness.service';
import { ROSTER_ABSENCE_GRACE_DAYS } from './roster-presence.service';

/**
 * How much sync history is worth keeping. Long enough to answer "when did this
 * source last break, and how often"; short enough that the table stays small.
 */
export const RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A bare per-student run key, with the optional `history:<year>:` backfill
 * prefix that `context.sourcePrefix` puts in front of one.
 *
 * Deliberately exact. `mail_counts:<connId>` and `schoolActivities:<connId>`
 * carry a colon and no student -- as do the legacy `schoolActivities:<userId>`
 * rows written before that key was corrected; a `<source>:<guid>:<connId>`
 * variant key is not a bare per-student key either, which the single
 * `[^:]+` segment is what rejects. Mistaking any of them for a guid would
 * delete live history on a student lookup that was never going to match.
 */
const PER_STUDENT_KEY = new RegExp(
  `^(?:history:\\d{4}:)?(?:${PER_STUDENT_SOURCES.join('|')}):([^:]+)$`,
);

/** The student guid a per-student run key names, or null if it names none. */
function guidInSource(source: string): string | null {
  return PER_STUDENT_KEY.exec(source)?.[1] ?? null;
}

/**
 * Ages out `sync_run`.
 *
 * Nothing pruned this table. The crons in ./tasks open roughly 1,600 rows a
 * day between them -- `notifications` and `mail_counts` every five minutes,
 * `homework` and `behavior` every twelve *per student* -- so it grew without
 * bound from the first deploy. Bounding the reads in `SyncRunService` fixed
 * the request-path symptom; this stops the table itself growing forever.
 */
@Injectable()
export class SyncRunRetentionService {
  private readonly logger = new Logger(SyncRunRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prune(now: Date = new Date()): Promise<number> {
    return (await this.pruneAged(now)) + (await this.pruneOrphanedStudents(now));
  }

  /** The 30-day window, minus the two rows per source the reads depend on. */
  private async pruneAged(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY);

    // The age filter alone is not safe: a source whose rows have all aged out
    // reads back as `never_synced`, which is a louder lie than a stale
    // timestamp. So the two rows `SyncRunService` actually reads per source --
    // the latest run and the latest successful run -- are retained whatever
    // their age, and only the history behind them is deleted.
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM sync_run
      WHERE "startedAt" < ${cutoff}
        AND id NOT IN (
          SELECT id FROM (
            SELECT DISTINCT ON (source) id
            FROM sync_run
            ORDER BY source, "startedAt" DESC
          ) latest_run
          UNION
          SELECT id FROM (
            SELECT DISTINCT ON (source) id
            FROM sync_run
            WHERE status = 'success'
            ORDER BY source, "endedAt" DESC NULLS LAST
          ) latest_success
        )
    `;

    if (deleted > 0) {
      this.logger.log(
        `Pruned ${deleted} sync_run rows older than ${RETENTION_DAYS} days.`,
      );
    }

    return deleted;
  }

  /**
   * Per-student rows for a guid no active `Student` claims.
   *
   * These are not history, they are debris. Once `RosterPresenceService`
   * retires a child, every per-student task skips her —
   * `studentScopeForContext` filters `isActive: true` — so her last run can
   * never be superseded. `FreshnessService` reads the newest success and the
   * newest failure for a key and compares them (`errorIsSpent`); if her final
   * run before retirement failed, that comparison is frozen on the wrong side
   * forever and `/more` prints a red error under a child who left months ago.
   * `SettingsService.studentGuidsIn` stops reading those keys; this stops them
   * existing, so the next child who changes school cannot reintroduce the row.
   *
   * The age gate is `ROSTER_ABSENCE_GRACE_DAYS`, the same window
   * `RosterPresenceService` waits before retiring anyone, and it is here for
   * the symmetric reason: a guid can legitimately have per-student runs before
   * its `Student` row is active — `StudentsTask` writes the roster and the
   * per-student tasks run seconds behind it — so nothing inside that window is
   * evidence of an orphan. A first sync must never be swept out from under
   * itself.
   */
  private async pruneOrphanedStudents(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - ROSTER_ABSENCE_GRACE_DAYS * MS_PER_DAY);

    // `groupBy`, not `findMany({ distinct })`: Prisma dedupes `distinct` in the
    // query engine, so that form would pull every row inside the window --
    // tens of thousands -- to recover a few hundred source names. This is a
    // SQL GROUP BY.
    const rows = await this.prisma.syncRun.groupBy({
      by: ['source'],
      where: { startedAt: { lt: cutoff } },
    });

    // source -> the guid it names. Parsed in TypeScript rather than SQL: the
    // prefix and variant-key rules above are not worth expressing twice.
    const guidBySource = new Map<string, string>();
    for (const { source } of rows) {
      const guid = guidInSource(source);
      if (guid) guidBySource.set(source, guid);
    }

    if (guidBySource.size === 0) return 0;

    const active = await this.prisma.student.findMany({
      where: { studentGuid: { in: [...new Set(guidBySource.values())] }, isActive: true },
      select: { studentGuid: true },
    });
    const activeGuids = new Set(active.map((student) => student.studentGuid));

    const orphaned = [...guidBySource.entries()]
      .filter(([, guid]) => !activeGuids.has(guid))
      .map(([source]) => source);

    if (orphaned.length === 0) return 0;

    // The exact source list, and the same age gate again: a source whose rows
    // straddle the cutoff keeps the recent ones.
    const { count } = await this.prisma.syncRun.deleteMany({
      where: { source: { in: orphaned }, startedAt: { lt: cutoff } },
    });

    if (count > 0) {
      this.logger.log(
        `Pruned ${count} sync_run rows for ${orphaned.length} orphaned per-student ` +
          `source(s) whose student is gone or inactive.`,
      );
    }

    return count;
  }
}
