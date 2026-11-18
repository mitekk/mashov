import { SyncRun } from '@prisma/client';
import { AchvasTask } from './achvas.task';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';

/**
 * The behaviour taxonomy is school-local, not global reference data.
 *
 * The old implementation said "Achvas are global reference data -- fetch once
 * using first available connection" and keyed the table on `code` alone. But
 * apis/get-api-achvas.md carries `teacherId` and `commonBehaveId`, the codes
 * are a school's own, and `justifiable` is that school's policy on whether an
 * absence excuses itself. One row per code meant whichever school synced last
 * decided, for every child in the household, whether an absence was excused.
 */

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'achvas',
    status: 'running',
    startedAt: new Date('2026-11-18T06:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
  } as unknown as SyncRun;
}

function makeAchva(overrides: Record<string, unknown> = {}) {
  return {
    code: 11,
    name: 'חיסור בשל פעילות בית-ספרית',
    hidden: false,
    achvaType: 1,
    commonBehaveId: 3,
    onDuplicateLesson: false,
    onLastBehave: false,
    aval: 0,
    displayOrder: 5,
    teacherId: 77,
    justifiable: true,
    hideFromStudents: false,
    preventPush: false,
    showInBehave: true,
    ...overrides,
  };
}

const CONN_A = {
  id: 'conn-a',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent-a',
  encryptedPassword: 'enc',
};
const CONN_B = {
  id: 'conn-b',
  schoolCode: 999999,
  schoolYear: 2027,
  username: 'parent-b',
  encryptedPassword: 'enc',
};

describe('AchvasTask', () => {
  let task: AchvasTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    householdConnection: { findMany: jest.Mock };
    behaviorTypeReference: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock };

  beforeEach(() => {
    mashovClient = {
      get: jest.fn().mockResolvedValue([makeAchva()]),
      getForConnection: jest.fn().mockResolvedValue([makeAchva()]),
    };
    prisma = {
      householdConnection: { findMany: jest.fn().mockResolvedValue([CONN_A]) },
      behaviorTypeReference: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(undefined),
    };

    task = new AchvasTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  it("writes the taxonomy under the fetching school's code", async () => {
    await task.execute();

    expect(prisma.behaviorTypeReference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolCode_code: { schoolCode: 540175, code: 11 } },
        create: expect.objectContaining({ schoolCode: 540175, code: 11 }),
      }),
    );
  });

  it('fetches once per school and keeps the two taxonomies apart', async () => {
    prisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
    mashovClient.getForConnection
      .mockResolvedValueOnce([makeAchva({ code: 11, justifiable: true })])
      .mockResolvedValueOnce([makeAchva({ code: 11, justifiable: false })]);

    await task.execute();

    expect(mashovClient.getForConnection).toHaveBeenCalledTimes(2);
    const written = prisma.behaviorTypeReference.upsert.mock.calls.map((call) => ({
      key: call[0].where.schoolCode_code,
      justifiable: call[0].create.justifiable,
    }));
    expect(written).toEqual([
      { key: { schoolCode: 540175, code: 11 }, justifiable: true },
      { key: { schoolCode: 999999, code: 11 }, justifiable: false },
    ]);
  });

  it('fetches once for two accounts at the same school', async () => {
    // Two parents at one school share the taxonomy. Fetching twice would race
    // two writers on the same rows for no new information.
    prisma.householdConnection.findMany.mockResolvedValue([
      CONN_A,
      { ...CONN_A, id: 'conn-a2', username: 'other-parent' },
    ]);

    await task.execute();

    expect(mashovClient.getForConnection).toHaveBeenCalledTimes(1);
  });

  it('opens one run per school so neither hides the other', async () => {
    prisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);

    await task.execute();

    expect(syncRunService.openRun).toHaveBeenCalledWith('achvas:540175', 'conn-a');
    expect(syncRunService.openRun).toHaveBeenCalledWith('achvas:999999', 'conn-b');
  });

  it("keeps syncing the second school when the first school's fetch fails", async () => {
    prisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
    mashovClient.getForConnection
      .mockRejectedValueOnce(new Error('403 from Mashov'))
      .mockResolvedValueOnce([makeAchva({ code: 2 })]);

    const result = await task.execute();

    expect(result.status).toBe('failed');
    expect(prisma.behaviorTypeReference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolCode_code: { schoolCode: 999999, code: 2 } },
      }),
    );
  });

  it('writes under the sentinel school code on the shared env session', async () => {
    // The shared session genuinely does not know its school here. 0 is the
    // same sentinel the column defaults to, and BehaviorClassifierService
    // falls back to it when a school has no row of its own yet.
    prisma.householdConnection.findMany.mockResolvedValue([]);

    await task.execute();

    expect(mashovClient.get).toHaveBeenCalled();
    expect(prisma.behaviorTypeReference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolCode_code: { schoolCode: 0, code: 11 } },
      }),
    );
  });

  it('narrows to the named connection on a targeted run', async () => {
    prisma.householdConnection.findMany.mockResolvedValue([CONN_B]);

    await task.execute({ connectionId: 'conn-b' });

    expect(prisma.householdConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'conn-b' }) }),
    );
    expect(mashovClient.get).not.toHaveBeenCalled();
  });
});
