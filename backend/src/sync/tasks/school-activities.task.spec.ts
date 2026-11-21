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
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock };

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
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.objectContaining({ fetchedCount: 3, updatedCount: 3 }),
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

    it('fails an activity whose start date is absent', async () => {
      mashovClient.getForConnection.mockResolvedValue([
        makeActivity({ id: 2, activityStartDate: undefined }),
      ]);

      const result = await task.execute();

      expect(prisma.schoolActivity.upsert).not.toHaveBeenCalled();
      expect(result.summary.failedCount).toBe(1);
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
