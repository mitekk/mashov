import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { SchoolActivitiesTask } from './school-activities.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'schoolActivities',
    status: 'running',
    startedAt: new Date('2026-11-17T00:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
  };
}

const CONNECTION = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  encryptedPassword: 'enc',
  userId: 'user-1',
  active: true,
};

function makeActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    createTime: '2026-09-01T00:00:00',
    activityStartDate: '2026-09-17T00:00:00',
    activityEndDate: '2026-09-17T00:00:00',
    activityType: 1,
    title: 'טיול שנתי',
    description: '<p>הסכמה</p>',
    endAnswerDate: '2026-09-10T00:00:00',
    isAnswered: false,
    ...overrides,
  };
}

describe('SchoolActivitiesTask', () => {
  let task: SchoolActivitiesTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    householdConnection: { findMany: jest.Mock };
    schoolActivity: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock; closeItemRun: jest.Mock };

  beforeEach(() => {
    mashovClient = {
      get: jest.fn().mockResolvedValue([]),
      getForConnection: jest.fn().mockResolvedValue([makeActivity()]),
    };
    prisma = {
      householdConnection: { findMany: jest.fn().mockResolvedValue([CONNECTION]) },
      schoolActivity: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(undefined),
      closeItemRun: jest.fn().mockResolvedValue(undefined),
    };

    task = new SchoolActivitiesTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  /** The data Prisma was asked to write, by activity id. */
  function upserted(activityId: number): Record<string, unknown> {
    const call = prisma.schoolActivity.upsert.mock.calls.find(
      ([arg]) => (arg as { create: { activityId: number } }).create.activityId === activityId,
    );
    expect(call).toBeDefined();
    return (call as [{ create: Record<string, unknown> }])[0].create;
  }

  describe('an activity with no response deadline', () => {
    // T13 finding 5. The task threw `unparseable activity dates on activity
    // <id>` whenever `new Date(item.endAnswerDate)` was NaN, which it was for
    // activity 3 at school A and activity 13 at school B — both schools, every
    // refresh. So `failedCount` was never zero, the task always reported
    // `failed`, and R12's honest `partial` envelope was permanently on, which
    // trains the parent to ignore it. An activity with no response deadline is
    // a legitimate thing for a school to publish; one optional upstream field
    // must not fail the whole task.
    it('stores it with a null deadline and keeps the batch a success', async () => {
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 1 }),
        makeActivity({ id: 2, endAnswerDate: undefined }),
        makeActivity({ id: 3 }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).toHaveBeenCalledTimes(3);
      expect(upserted(2).endAnswerDate).toBeNull();
      expect(upserted(1).endAnswerDate).toBeInstanceOf(Date);
      expect(result.status).toBe('success');
      expect(result.summary.failedCount).toBe(0);
      expect(syncRunService.closeItemRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ fetchedCount: 3, updatedCount: 3, itemFailures: 0 }),
      );
    });

    it('treats an explicit null and a blank string the same way', async () => {
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 4, endAnswerDate: null }),
        makeActivity({ id: 5, endAnswerDate: '   ' }),
      ]);

      const result = await task.execute();

      expect(upserted(4).endAnswerDate).toBeNull();
      expect(upserted(5).endAnswerDate).toBeNull();
      expect(result.summary.failedCount).toBe(0);
    });
  });

  describe('a date that is present and genuinely wrong', () => {
    // No blanket `catch`: a real failure stays a failure.
    it('still counts a malformed non-empty endAnswerDate as a failed item', async () => {
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 1 }),
        makeActivity({ id: 2, endAnswerDate: 'not-a-date' }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBe(1);
      // The raw value rides along, so the next live run names the shape in one
      // log line instead of another attended session.
      expect(result.errorMessages.join(' ')).toContain('not-a-date');
    });

    it('still counts an unparseable activityStartDate as a failed item', async () => {
      // A dateless activity has nothing to show, so this one keeps throwing
      // whatever `endAnswerDate` carries.
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 2, activityStartDate: 'not-a-date' }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).not.toHaveBeenCalled();
      expect(result.summary.failedCount).toBe(1);
    });

    it('fails a non-string deadline rather than storing 1970', async () => {
      // `0` and `false` are present and not `''`, so they reached `new Date()`
      // and produced a VALID Date at the epoch — a 1970 response deadline
      // stored silently. Mashov documents this field as a string; anything
      // else is an unexpected shape, and naming it in the log beats inventing
      // a deadline the school never set.
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 1, endAnswerDate: 0 }),
        makeActivity({ id: 2, endAnswerDate: false }),
        makeActivity({ id: 3, endAnswerDate: { when: 'soon' } }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).not.toHaveBeenCalled();
      expect(result.summary.failedCount).toBe(3);
      expect(result.errorMessages.join(' ')).toContain('endAnswerDate');
    });

    it('fails a non-string start date rather than storing 1970', async () => {
      // Same class on the field that was already required.
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 1, activityStartDate: 0 }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).not.toHaveBeenCalled();
      expect(result.summary.failedCount).toBe(1);
      expect(result.errorMessages.join(' ')).toContain('activityStartDate');
    });

    it('fails an activity whose start date is absent', async () => {
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 2, activityStartDate: undefined }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).not.toHaveBeenCalled();
      expect(result.summary.failedCount).toBe(1);
    });
  });

  /**
   * Two schools in one household, which is the shape that put a permanent
   * "הסנכרון נכשל" on `/more` while both schools were in fact answering.
   *
   * `userId` is the MERGED household (ADR-0031), so keying the run on it gave
   * both connections one `sync_run.source`. `getAllSourceHealth` resolves its
   * rows with `SELECT DISTINCT ON (source)`, so only the last iteration
   * survived: school A's success was discarded and school B's transient 401
   * became the household's entire school-activities health -- and because the
   * discarded success ended two milliseconds BEFORE the failure opened,
   * `errorIsSpent` could not retire the message either.
   *
   * The second half is the same bug in the stamp. `openRun` was handed
   * `context.connectionId`, which is null on every `@Cron` and every
   * unscoped `POST /sync/refresh`, so neither row carried the connection that
   * produced it and the connection-scoped read could not tell them apart.
   * `user-details.task.ts` and `mail-counts.task.ts` are the precedent: both
   * iterate connections and both key and stamp on `conn.id`.
   */
  describe('two connections in one household', () => {
    const SECOND = { ...CONNECTION, id: 'conn-2', schoolCode: 5678 };

    beforeEach(() => {
      prisma.householdConnection.findMany.mockResolvedValue([CONNECTION, SECOND]);
    });

    it('opens one run per connection, keyed and stamped on the connection', async () => {
      await task.execute();

      expect(syncRunService.openRun.mock.calls).toEqual([
        ['schoolActivities:conn-1', 'conn-1'],
        ['schoolActivities:conn-2', 'conn-2'],
      ]);
    });

    it("does not let one school's failure land on the other school's run", async () => {
      mashovClient.getForConnection
        .mockResolvedValueOnce([makeActivity()])
        .mockRejectedValueOnce(new Error('Request failed with status code 401'));
      syncRunService.openRun
        .mockResolvedValueOnce(makeSyncRun('run-1'))
        .mockResolvedValueOnce(makeSyncRun('run-2'));

      await task.execute();

      // The healthy school closes its OWN run successfully...
      expect(syncRunService.closeItemRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ fetchedCount: 1, itemFailures: 0 }),
      );
      // ...and the 401 is recorded against the other school's run alone.
      expect(syncRunService.closeRun).toHaveBeenCalledWith('run-2', 'failed', {
        errorMessage: 'Request failed with status code 401',
      });
      expect(syncRunService.closeRun).not.toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.anything(),
      );
    });
  });

  it('upserts a well-formed batch and reports success', async () => {
    const result = await task.execute();

    expect(result.status).toBe('success');
    expect(result.summary).toEqual({
      fetchedCount: 1,
      createdCount: 0,
      updatedCount: 1,
      failedCount: 0,
    });
  });
});
