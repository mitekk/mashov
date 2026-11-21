import { SyncRunRetentionService, RETENTION_DAYS } from './sync-run-retention.service';
import { ROSTER_ABSENCE_GRACE_DAYS } from './roster-presence.service';
import type { PrismaService } from '../prisma/prisma.service';

const NOW = new Date('2026-11-17T12:00:00Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function makeMockPrisma(
  deleted = 0,
  options: {
    sources?: string[];
    activeGuids?: string[];
  } = {},
) {
  const executeRaw = jest.fn().mockResolvedValue(deleted);
  const syncRunGroupBy = jest
    .fn()
    .mockResolvedValue((options.sources ?? []).map((source) => ({ source })));
  const syncRunDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const studentFindMany = jest
    .fn()
    .mockResolvedValue((options.activeGuids ?? []).map((studentGuid) => ({ studentGuid })));

  return {
    prisma: {
      $executeRaw: executeRaw,
      syncRun: { groupBy: syncRunGroupBy, deleteMany: syncRunDeleteMany },
      student: { findMany: studentFindMany },
    } as unknown as PrismaService,
    executeRaw,
    syncRunGroupBy,
    syncRunDeleteMany,
    studentFindMany,
  };
}

/** The exact source list a deleteMany call targeted. */
function deletedSources(mock: jest.Mock): string[] {
  const where = mock.mock.calls[0]?.[0]?.where as
    | { source?: { in?: string[] } }
    | undefined;
  return where?.source?.in ?? [];
}

/** The SQL text of a tagged-template call, whitespace-collapsed. */
function sqlOf(mock: jest.Mock): string {
  const strings = mock.mock.calls[0][0] as string[];
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}

describe('SyncRunRetentionService', () => {
  it('deletes rows older than the retention window', async () => {
    const { prisma, executeRaw } = makeMockPrisma(12);
    const service = new SyncRunRetentionService(prisma);

    const deleted = await service.prune(NOW);

    expect(deleted).toBe(12);
    const cutoff = executeRaw.mock.calls[0][1] as Date;
    const expected = new Date(NOW.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  // A source whose every row aged out reads back as never_synced, which is a
  // worse answer than a stale timestamp.
  it('retains the latest run and the latest successful run per source', async () => {
    const { prisma, executeRaw } = makeMockPrisma();
    const service = new SyncRunRetentionService(prisma);

    await service.prune(NOW);

    const sql = sqlOf(executeRaw);
    expect(sql).toContain('id NOT IN');
    expect(sql).toContain("status = 'success'");
    // Two retained sets: newest per source, and newest successful per source.
    expect(sql.match(/DISTINCT ON \(source\)/g)).toHaveLength(2);
  });

  it('stays quiet when there is nothing to prune', async () => {
    const { prisma } = makeMockPrisma(0);
    const service = new SyncRunRetentionService(prisma);

    await expect(service.prune(NOW)).resolves.toBe(0);
  });

  // A departed child's per-student keys outlive every task that would touch
  // them: `studentScopeForContext` filters `isActive: true`, so no future run
  // can supersede her last one. If that last run failed, `errorIsSpent` never
  // fires and `/more` prints the error forever. Filtering the read (see
  // `SettingsService.studentGuidsIn`) hides it; this deletes it, so the next
  // child who changes school does not reintroduce it.
  describe('orphaned per-student sources', () => {
    it('deletes per-student rows for a guid with no active student', async () => {
      const { prisma, syncRunDeleteMany } = makeMockPrisma(0, {
        sources: ['homework:dead-guid', 'behavior:dead-guid', 'homework:live-guid'],
        activeGuids: ['live-guid'],
      });
      const service = new SyncRunRetentionService(prisma);

      await service.prune(NOW);

      expect(deletedSources(syncRunDeleteMany).sort()).toEqual([
        'behavior:dead-guid',
        'homework:dead-guid',
      ]);
    });

    it('leaves non-per-student colon keys alone', async () => {
      // `mail_counts:<connId>` and `schoolActivities:<userId>` carry a colon
      // but no student, and a `<source>:<guid>:<connId>` variant key is not a
      // bare per-student key either. Sweeping any of them on a guid lookup
      // would delete live history.
      const { prisma, syncRunDeleteMany, studentFindMany } = makeMockPrisma(0, {
        sources: [
          'mail_counts:conn-1',
          'schoolActivities:user-9',
          'homework:dead-guid:conn-1',
          'notifications',
        ],
      });
      const service = new SyncRunRetentionService(prisma);

      await service.prune(NOW);

      expect(studentFindMany).not.toHaveBeenCalled();
      expect(syncRunDeleteMany).not.toHaveBeenCalled();
    });

    it('sweeps backfill keys for the same orphan', async () => {
      // `history:<year>:homework:<guid>` is the same guid under
      // `context.sourcePrefix`. Same orphan, same reasoning.
      const { prisma, syncRunDeleteMany } = makeMockPrisma(0, {
        sources: ['history:2025:homework:dead-guid', 'history:2025:complete'],
        activeGuids: [],
      });
      const service = new SyncRunRetentionService(prisma);

      await service.prune(NOW);

      expect(deletedSources(syncRunDeleteMany)).toEqual([
        'history:2025:homework:dead-guid',
      ]);
    });

    it('retains an orphan row younger than the roster absence grace', async () => {
      // `StudentsTask` creates the Student row, and the per-student tasks run
      // moments later. Between those two writes the guid has no *active* row
      // yet from this sweep's point of view on a partly-seeded database, and a
      // first sync must never be swept out from under itself.
      const { prisma, syncRunGroupBy, syncRunDeleteMany } = makeMockPrisma(0, {
        sources: ['homework:dead-guid'],
        activeGuids: [],
      });
      const service = new SyncRunRetentionService(prisma);

      await service.prune(NOW);

      const graceCutoff = daysAgo(ROSTER_ABSENCE_GRACE_DAYS);
      for (const mock of [syncRunGroupBy, syncRunDeleteMany]) {
        const where = mock.mock.calls[0]?.[0]?.where as { startedAt?: { lt?: Date } };
        expect(where?.startedAt?.lt?.toISOString()).toBe(graceCutoff.toISOString());
      }
    });

    it('counts the orphan rows it deleted alongside the aged-out ones', async () => {
      const { prisma, syncRunDeleteMany } = makeMockPrisma(12, {
        sources: ['homework:dead-guid'],
        activeGuids: [],
      });
      syncRunDeleteMany.mockResolvedValue({ count: 5 });
      const service = new SyncRunRetentionService(prisma);

      await expect(service.prune(NOW)).resolves.toBe(17);
    });
  });
});
