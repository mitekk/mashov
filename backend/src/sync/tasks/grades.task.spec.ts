import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { GradesTask } from './grades.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'grades',
    status: 'running',
    startedAt: new Date('2026-11-25T00:00:00Z'),
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

const STUDENT = {
  studentGuid: 'stu-1',
  fullName: 'Avi Cohen',
};

const CONNECTION = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  encryptedPassword: 'enc',
  userId: 'user-1',
  active: true,
};

function makeGrade(overrides: Record<string, unknown> = {}) {
  return {
    year: 2027,
    studentGuid: 'stu-1',
    gradingEventId: 18,
    grade: 93,
    rate: 0.0,
    timestamp: '2026-09-17T14:04:41',
    teacherName: 'קליין יעל',
    groupId: 202,
    groupName: 'מתמטיקה ז8',
    subjectName: 'מתמטיקה',
    eventDate: '2026-09-16T00:00:00',
    id: 18,
    gradingPeriod: 1,
    gradingEvent: 'היכרות עם מערכת צירים',
    gradeRate: 0.0,
    gradeTypeId: 7,
    gradeType: 'מטלה עם ציון',
    ...overrides,
  };
}

describe('GradesTask', () => {
  let task: GradesTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    student: { findMany: jest.Mock; update: jest.Mock };
    householdConnection: { findMany: jest.Mock; findFirst: jest.Mock };
    gradeItem: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock; closeItemRun: jest.Mock };

  beforeEach(() => {
    mashovClient = {
      get: jest.fn().mockResolvedValue([]),
      getForConnection: jest.fn().mockResolvedValue([makeGrade()]),
    };
    prisma = {
      student: {
        findMany: jest.fn().mockResolvedValue([STUDENT]),
        update: jest.fn().mockResolvedValue({}),
      },
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([CONNECTION]),
        findFirst: jest.fn().mockResolvedValue({ schoolYear: 2027 }),
      },
      gradeItem: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(undefined),
      closeItemRun: jest.fn().mockResolvedValue(undefined),
    };

    task = new GradesTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  it('upserts on the grading event within the student-year', async () => {
    // gradingEventId is only unique within a year upstream, so the year has to
    // be part of the key or last year's row is what this year's write lands on.
    await task.execute();

    expect(prisma.gradeItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentGuid_schoolYear_gradingEventId: {
            studentGuid: 'stu-1',
            schoolYear: 2027,
            gradingEventId: 18,
          },
        },
      }),
    );
  });

  it('maps the upstream payload onto the row, timestamp as enteredAt', async () => {
    await task.execute();

    const { create } = prisma.gradeItem.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      schoolYear: 2027,
      studentGuid: 'stu-1',
      gradingEventId: 18,
      grade: 93,
      gradingPeriod: 1,
      gradeTypeId: 7,
      gradeType: 'מטלה עם ציון',
      gradingEvent: 'היכרות עם מערכת צירים',
      groupId: 202,
      groupName: 'מתמטיקה ז8',
      subjectName: 'מתמטיקה',
      teacherName: 'קליין יעל',
    });
    // The assessment happened on the 16th; the teacher keyed it in on the 17th.
    expect(create.eventDate).toEqual(new Date('2026-09-16T00:00:00'));
    expect(create.enteredAt).toEqual(new Date('2026-09-17T14:04:41'));
  });

  it('asks upstream for the student-scoped grades resource', async () => {
    await task.execute();

    const [path, , , , , , options] = mashovClient.getForConnection.mock.calls[0];
    expect(path).toBe('/api/students/stu-1/grades');
    expect(options.headers.Referer).toBe(
      'https://web.mashov.info/students/main/students/stu-1/regularGrades',
    );
  });

  it('records a successful run per student', async () => {
    await task.execute();

    expect(syncRunService.openRun).toHaveBeenCalledWith('grades:stu-1', undefined);
    expect(syncRunService.closeItemRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ fetchedCount: 1, updatedCount: 1, itemFailures: 0 }),
    );
  });

  it('reports the run failed when the grades it fetched could not be persisted', async () => {
    // THE REGRESSION, end to end through the task. The upsert loop catches a
    // per-item error and carries on -- right, since one bad row must not cost
    // the others -- but the run was then closed `'success'` regardless. So a
    // child whose grades ALL failed to persist got a success run carrying
    // `fetchedCount: 1, updatedCount: 0`, and `getLatestSuccessfulRuns`
    // filters on `status = 'success'`, so that row satisfied the
    // sync-on-read TTL gate: ציונים stayed empty for the full 6h while
    // `source-health` reported `fresh`. Same end state as the per-student
    // freshness bug (#60), reached by a different route.
    prisma.gradeItem.upsert.mockRejectedValue(new Error('unique constraint violated'));

    const result = await task.execute();

    expect(syncRunService.closeItemRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        fetchedCount: 1,
        updatedCount: 0,
        itemFailures: 1,
        itemErrors: [expect.stringContaining('unique constraint violated')],
      }),
    );
    // The aggregate was always right; it is the persisted row that was not.
    expect(result.status).toBe('failed');
  });

  describe('owner-first fan-out', () => {
    const CONN_A = { ...CONNECTION, id: 'conn-a', schoolCode: 540175, schoolYear: 2026 };
    const CONN_B = { ...CONNECTION, id: 'conn-b', schoolCode: 999999, schoolYear: 2027 };

    beforeEach(() => {
      prisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
    });

    it('makes exactly one upstream call for a stamped student', async () => {
      prisma.student.findMany.mockResolvedValue([
        { ...STUDENT, householdConnectionId: 'conn-b' },
      ]);

      await task.execute();

      expect(mashovClient.getForConnection).toHaveBeenCalledTimes(1);
      const [, connectionId] = mashovClient.getForConnection.mock.calls[0] as [string, string];
      expect(connectionId).toBe('conn-b');
    });

    it("stamps the row with the owner's year, not the first connection's", async () => {
      prisma.student.findMany.mockResolvedValue([
        { ...STUDENT, householdConnectionId: 'conn-b' },
      ]);

      await task.execute();

      expect(prisma.gradeItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ schoolYear: 2027 }),
        }),
      );
    });

    it('stamps an unstamped student with whichever connection answered', async () => {
      prisma.student.findMany.mockResolvedValue([
        { ...STUDENT, householdConnectionId: null },
      ]);
      mashovClient.getForConnection
        .mockRejectedValueOnce(new Error('403'))
        .mockResolvedValueOnce([makeGrade()]);

      await task.execute();

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { studentGuid: 'stu-1' },
        data: { householdConnectionId: 'conn-b' },
      });
    });

    it('writes no stamp when the owner answers', async () => {
      prisma.student.findMany.mockResolvedValue([
        { ...STUDENT, householdConnectionId: 'conn-a' },
      ]);

      await task.execute();

      expect(prisma.student.update).not.toHaveBeenCalled();
    });
  });

  describe('upstream failure reporting', () => {
    it('reports failure when every connection fails for a student', async () => {
      // Reporting success here would hide a broken live sync behind a green run.
      mashovClient.getForConnection.mockRejectedValue(new Error('401 from Mashov'));

      const result = await task.execute({ connectionId: 'conn-1' });

      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBeGreaterThan(0);
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('stu-1') }),
      );
      expect(prisma.gradeItem.upsert).not.toHaveBeenCalled();
    });

    it('still succeeds when a later connection answers after an earlier one fails', async () => {
      prisma.householdConnection.findMany.mockResolvedValue([
        { ...CONNECTION, id: 'conn-broken' },
        { ...CONNECTION, id: 'conn-good' },
      ]);
      mashovClient.getForConnection
        .mockRejectedValueOnce(new Error('401 from Mashov'))
        .mockResolvedValueOnce([makeGrade()]);

      const result = await task.execute();

      expect(result.status).toBe('success');
      expect(prisma.gradeItem.upsert).toHaveBeenCalled();
    });
  });

  describe('historical year context', () => {
    it('stamps and fetches the context school year when given one', async () => {
      await task.execute({ connectionId: 'conn-1', schoolYear: 2026 });

      expect(mashovClient.getForConnection.mock.calls[0]).toContain(2026);
      expect(prisma.gradeItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ schoolYear: 2026 }),
          where: {
            studentGuid_schoolYear_gradingEventId: {
              studentGuid: 'stu-1',
              schoolYear: 2026,
              gradingEventId: 18,
            },
          },
        }),
      );
    });

    it('prefixes the run source when given a source prefix', async () => {
      await task.execute({
        connectionId: 'conn-1',
        schoolYear: 2026,
        sourcePrefix: 'history:2026:',
      });

      expect(syncRunService.openRun).toHaveBeenCalledWith(
        'history:2026:grades:stu-1',
        'conn-1',
      );
    });

    it('reports success without touching upstream when no connection exists', async () => {
      // Was three shared-session tests. There is no shared session any more:
      // with no connection there are no credentials to fetch with, and the
      // empty deployment is not a failure. A `failed` run here could only be
      // keyed on the bare source name, which the NULL-owner rule shows to
      // every household.
      prisma.householdConnection.findMany.mockResolvedValue([]);

      const result = await task.execute();

      expect(result.status).toBe('success');
      expect(result.summary.failedCount).toBe(0);
      expect(syncRunService.openRun).not.toHaveBeenCalled();
      expect(prisma.gradeItem.upsert).not.toHaveBeenCalled();
    });

    it('reports a failure when a named connection resolves to nothing', async () => {
      // A targeted refresh has a requester, so silence would be a lie.
      prisma.householdConnection.findMany.mockResolvedValue([]);

      const result = await task.execute({ connectionId: 'conn-gone' });

      expect(result.status).toBe('failed');
      expect(syncRunService.openRun).toHaveBeenCalledWith('grades:conn-gone', 'conn-gone');
      expect(prisma.gradeItem.upsert).not.toHaveBeenCalled();
    });

    it('carries every connection failure into the error it throws', async () => {
      // Without this the real cause is stranded in a per-connection warn line
      // and `/more` shows a diagnosis-free "every connection failed".
      prisma.householdConnection.findMany.mockResolvedValue([
        { ...CONNECTION, id: 'conn-a' },
        { ...CONNECTION, id: 'conn-b' },
      ]);
      mashovClient.getForConnection
        .mockRejectedValueOnce(new Error('401 from Mashov'))
        .mockRejectedValueOnce(new Error('503 from Mashov'));

      const result = await task.execute();

      expect(result.status).toBe('failed');
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({
          errorMessage: expect.stringContaining('401 from Mashov'),
        }),
      );
    });
  });
});
