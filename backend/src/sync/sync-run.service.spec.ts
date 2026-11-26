import { SyncRunService } from './sync-run.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

function makeSyncRun(overrides?: Partial<SyncRun>): SyncRun {
  return {
    id: 'run-1',
    source: 'notifications',
    status: 'running',
    startedAt: new Date('2026-03-11T10:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
    ...overrides,
  } as SyncRun;
}

function makeMockPrisma(overrides: Partial<{
  syncRunCreate: jest.Mock;
  syncRunUpdate: jest.Mock;
  syncRunFindFirst: jest.Mock;
  syncRunFindMany: jest.Mock;
  queryRaw: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    syncRun: {
      create: overrides.syncRunCreate ?? jest.fn().mockResolvedValue(makeSyncRun()),
      update: overrides.syncRunUpdate ?? jest.fn().mockResolvedValue(makeSyncRun()),
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
      findMany: overrides.syncRunFindMany ?? jest.fn().mockResolvedValue([]),
    },
    $queryRaw: overrides.queryRaw ?? jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<PrismaService>;
}

/** The SQL text of a tagged-template $queryRaw call, whitespace-collapsed. */
function sqlOf(mock: jest.Mock): string {
  const strings = mock.mock.calls[0][0] as string[];
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}

describe('SyncRunService', () => {
  describe('openRun', () => {
    it('creates a sync run record with status=running', async () => {
      const mockCreate = jest.fn().mockResolvedValue(makeSyncRun());
      const service = new SyncRunService(makeMockPrisma({ syncRunCreate: mockCreate }));

      await service.openRun('notifications');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'notifications',
            status: 'running',
            startedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns the created SyncRun', async () => {
      const expected = makeSyncRun({ id: 'run-abc' });
      const service = new SyncRunService(
        makeMockPrisma({ syncRunCreate: jest.fn().mockResolvedValue(expected) }),
      );

      const result = await service.openRun('notifications');
      expect(result.id).toBe('run-abc');
      expect(result.status).toBe('running');
    });

    it('persists householdConnectionId when provided', async () => {
      const mockCreate = jest.fn().mockResolvedValue(
        makeSyncRun({ householdConnectionId: 'conn-123' }),
      );
      const service = new SyncRunService(makeMockPrisma({ syncRunCreate: mockCreate }));

      await service.openRun('notifications', 'conn-123');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            householdConnectionId: 'conn-123',
          }),
        }),
      );
    });
  });

  describe('closeRun', () => {
    it('closes the run with success status and counts', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(makeSyncRun({ status: 'success', fetchedCount: 10 }));
      const service = new SyncRunService(makeMockPrisma({ syncRunUpdate: mockUpdate }));

      await service.closeRun('run-1', 'success', { fetchedCount: 10, createdCount: 5, updatedCount: 5 });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({
            status: 'success',
            endedAt: expect.any(Date),
            fetchedCount: 10,
          }),
        }),
      );
    });

    it('closes the run with failed status and error message', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(makeSyncRun({ status: 'failed' }));
      const service = new SyncRunService(makeMockPrisma({ syncRunUpdate: mockUpdate }));

      await service.closeRun('run-1', 'failed', { errorMessage: 'Network timeout' });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed', errorMessage: 'Network timeout' }),
        }),
      );
    });
  });

  describe('closeItemRun', () => {
    function updateDataFor(
      options: Parameters<SyncRunService['closeItemRun']>[1],
    ): Promise<Record<string, unknown>> {
      const mockUpdate = jest.fn().mockResolvedValue(makeSyncRun());
      const service = new SyncRunService(makeMockPrisma({ syncRunUpdate: mockUpdate }));
      return service
        .closeItemRun('run-1', options)
        .then(() => mockUpdate.mock.calls[0][0].data as Record<string, unknown>);
    }

    it('closes success when every item persisted', async () => {
      const data = await updateDataFor({
        fetchedCount: 10,
        updatedCount: 10,
        itemFailures: 0,
      });

      expect(data.status).toBe('success');
      expect(data.fetchedCount).toBe(10);
      // Nothing failed, so nothing to explain.
      expect(data.errorMessage).toBeUndefined();
    });

    it('closes failed when every item failed, instead of a green run over an empty table', async () => {
      // THE REGRESSION. The upsert loop catches per-item errors and continues,
      // and the run was then closed 'success' unconditionally -- so a student
      // whose grades all failed to persist got a success run carrying
      // `fetchedCount: 40, updatedCount: 0`. `getLatestSuccessfulRuns` filters
      // on `status = 'success'`, so that row satisfied the sync-on-read TTL
      // gate: the section stayed empty for the full 6h while `source-health`
      // read `fresh`. Same end state as the #60 bug, different route.
      const data = await updateDataFor({
        fetchedCount: 40,
        updatedCount: 0,
        itemFailures: 40,
        itemErrors: ['unique constraint violated'],
      });

      expect(data.status).toBe('failed');
    });

    it('closes failed when only some items failed', async () => {
      // Not `partial`: see the method's own comment. A source that cannot
      // persist part of what it fetched should retry inside the backoff window
      // rather than claim freshness for its whole TTL.
      const data = await updateDataFor({
        fetchedCount: 40,
        updatedCount: 39,
        itemFailures: 1,
        itemErrors: ['bad date'],
      });

      expect(data.status).toBe('failed');
    });

    it('keeps the counts on a failed run, so the partial progress stays visible', async () => {
      const data = await updateDataFor({
        fetchedCount: 40,
        createdCount: 30,
        updatedCount: 9,
        itemFailures: 1,
        itemErrors: ['bad date'],
      });

      expect(data.fetchedCount).toBe(40);
      expect(data.createdCount).toBe(30);
      expect(data.updatedCount).toBe(9);
    });

    it('explains how many of how many failed, and why', async () => {
      // `source-health` surfaces `lastErrorMessage`. "1 of 40" is the whole
      // diagnosis; without it the row says failed and nothing else.
      const data = await updateDataFor({
        fetchedCount: 40,
        updatedCount: 39,
        itemFailures: 1,
        itemErrors: ['bad date'],
      });

      expect(data.errorMessage).toContain('1 of 40');
      expect(data.errorMessage).toContain('bad date');
    });

    it('still explains itself when the caller collected no messages', async () => {
      const data = await updateDataFor({ fetchedCount: 5, updatedCount: 0, itemFailures: 5 });

      expect(data.status).toBe('failed');
      expect(data.errorMessage).toContain('5 of 5');
    });

    it('caps the message instead of writing an unbounded row', async () => {
      // One broken payload shape fails every item, and the column would
      // otherwise carry one copy of the message per item.
      const data = await updateDataFor({
        fetchedCount: 500,
        updatedCount: 0,
        itemFailures: 500,
        itemErrors: Array.from({ length: 500 }, (_, i) => `failure number ${i}`),
      });

      expect(String(data.errorMessage).length).toBeLessThan(500);
    });

    it('never writes partial, which the health reader counts as neither', async () => {
      // `freshness.service.ts` picks `latestFailure` on `status === 'failed'`
      // only, and `getLatestSuccessfulRuns` filters `status = 'success'`. A
      // `partial` row is neither, so a source whose only run was partial would
      // report `never_synced` with a null error -- a new silent failure.
      for (const itemFailures of [0, 1, 40]) {
        const data = await updateDataFor({ fetchedCount: 40, updatedCount: 1, itemFailures });
        expect(data.status).not.toBe('partial');
      }
    });
  });

  describe('getLatestSuccessfulRun', () => {
    it('returns null when no successful run exists', async () => {
      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindFirst: jest.fn().mockResolvedValue(null) }),
      );

      const result = await service.getLatestSuccessfulRun('notifications');
      expect(result).toBeNull();
    });

    it('returns the latest successful run for the given source', async () => {
      const run = makeSyncRun({ status: 'success', endedAt: new Date() });
      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindFirst: jest.fn().mockResolvedValue(run) }),
      );

      const result = await service.getLatestSuccessfulRun('notifications');
      expect(result?.status).toBe('success');
    });
  });

  describe('getAllSourceHealth', () => {
    it('returns an empty Map when there are no sync runs', async () => {
      const service = new SyncRunService(
        makeMockPrisma({ queryRaw: jest.fn().mockResolvedValue([]) }),
      );

      const result = await service.getAllSourceHealth();
      expect(result.size).toBe(0);
    });

    it('keys the latest run per source', async () => {
      const runs = [
        makeSyncRun({ id: 'run-2', source: 'notifications', status: 'success' }),
        makeSyncRun({ id: 'run-3', source: 'mail_inbox', status: 'success' }),
      ];
      const service = new SyncRunService(
        makeMockPrisma({ queryRaw: jest.fn().mockResolvedValue(runs) }),
      );

      const result = await service.getAllSourceHealth();
      expect(result.size).toBe(2);
      expect(result.get('notifications')?.id).toBe('run-2');
    });

    // The regression this method exists to prevent: sync_run grows without
    // bound, so the dedup must happen in the database, not over every row.
    it('bounds the result set in SQL rather than loading the table', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const findMany = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(
        makeMockPrisma({ queryRaw, syncRunFindMany: findMany }),
      );

      await service.getAllSourceHealth();

      expect(findMany).not.toHaveBeenCalled();
      expect(sqlOf(queryRaw)).toContain('DISTINCT ON (source)');
    });

    // GET /api/v1/settings/source-health returned every household's sources to
    // any signed-in user -- foreign student GUIDs included, because they are
    // part of the source key.
    it('filters to one connection when the caller is scoped', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getAllSourceHealth('conn-1');

      expect(sqlOf(queryRaw)).toContain('"householdConnectionId" =');
      expect(queryRaw.mock.calls[0].slice(1)).toEqual(['conn-1']);
    });

    // Every scheduled task calls execute() with no context, so a cron run
    // stores householdConnectionId = NULL. Filtering those out would report
    // `never_synced` for a system whose crons are working perfectly -- which
    // is the one thing this endpoint exists to tell the truth about.
    it('keeps unattributed cron runs in a scoped read', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getAllSourceHealth('conn-1');

      expect(sqlOf(queryRaw)).toContain('"householdConnectionId" IS NULL');
    });

    it('does not filter when no connection is given', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getAllSourceHealth();

      expect(sqlOf(queryRaw)).not.toContain('householdConnectionId');
    });
  });

  describe('getLatestSuccessfulRuns', () => {
    it('keys the latest successful run per source', async () => {
      const runs = [
        makeSyncRun({ id: 'run-2', source: 'notifications', status: 'success', endedAt: new Date() }),
      ];
      const service = new SyncRunService(
        makeMockPrisma({ queryRaw: jest.fn().mockResolvedValue(runs) }),
      );

      const result = await service.getLatestSuccessfulRuns();
      expect(result.size).toBe(1);
      expect(result.get('notifications')?.id).toBe('run-2');
    });

    it('bounds the result set in SQL and filters to successful runs', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const findMany = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(
        makeMockPrisma({ queryRaw, syncRunFindMany: findMany }),
      );

      await service.getLatestSuccessfulRuns();

      expect(findMany).not.toHaveBeenCalled();
      const sql = sqlOf(queryRaw);
      expect(sql).toContain('DISTINCT ON (source)');
      expect(sql).toContain("status = 'success'");
    });

    // A running row carries endedAt=null; DESC defaults to NULLS FIRST, which
    // would hide the newest usable run behind it.
    it('orders endedAt NULLS LAST so an unfinished run cannot win', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getLatestSuccessfulRuns();

      expect(sqlOf(queryRaw)).toContain('"endedAt" DESC NULLS LAST');
    });

    it('filters to one connection when the caller is scoped', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getLatestSuccessfulRuns('conn-1');

      const sql = sqlOf(queryRaw);
      expect(sql).toContain('"householdConnectionId" =');
      expect(sql).toContain("status = 'success'");
      expect(sql).toContain('"householdConnectionId" IS NULL');
      expect(queryRaw.mock.calls[0].slice(1)).toEqual(['conn-1']);
    });

    it('does not filter when no connection is given', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const service = new SyncRunService(makeMockPrisma({ queryRaw }));

      await service.getLatestSuccessfulRuns();

      expect(sqlOf(queryRaw)).not.toContain('householdConnectionId');
    });
  });
});
