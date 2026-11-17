import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { MashovSessionService } from '../../session/mashov-session.service';
import { RosterPresenceService } from '../roster-presence.service';
import { StudentsTask } from './students.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'students',
    status: 'running',
    startedAt: new Date('2026-11-17T00:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: null,
    householdConnectionId: null,
  };
}

describe('StudentsTask', () => {
  let task: StudentsTask;
  let mockPrisma: { householdConnection: { findMany: jest.Mock } };
  let mockSyncRunService: { openRun: jest.Mock; closeRun: jest.Mock };
  let mockSessionService: { refreshRosterForConnection: jest.Mock };
  let mockRosterPresence: { sweep: jest.Mock };

  beforeEach(() => {
    mockPrisma = {
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'conn-1', schoolCode: 1234, schoolYear: 2027 },
          { id: 'conn-2', schoolCode: 5678, schoolYear: 2027 },
        ]),
      },
    };
    mockSyncRunService = {
      openRun: jest.fn().mockImplementation((_source, _conn) => makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(undefined),
    };
    mockSessionService = {
      refreshRosterForConnection: jest
        .fn()
        .mockResolvedValue({ created: 1, updated: 2, deactivated: 0, year: 2027 }),
    };

    mockRosterPresence = { sweep: jest.fn().mockResolvedValue(0) };

    task = new StudentsTask(
      mockPrisma as unknown as PrismaService,
      mockSyncRunService as unknown as SyncRunService,
      mockSessionService as unknown as MashovSessionService,
      mockRosterPresence as unknown as RosterPresenceService,
    );
  });

  it('refreshes the roster for every active connection', async () => {
    await task.execute();

    expect(mockSessionService.refreshRosterForConnection).toHaveBeenCalledWith('conn-1');
    expect(mockSessionService.refreshRosterForConnection).toHaveBeenCalledWith('conn-2');
  });

  it('scopes the run to one connection when the context names one', async () => {
    mockPrisma.householdConnection.findMany.mockResolvedValue([
      { id: 'conn-2', schoolCode: 5678, schoolYear: 2027 },
    ]);

    await task.execute({ connectionId: 'conn-2' });

    expect(mockPrisma.householdConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'conn-2' }),
      }),
    );
    expect(mockSessionService.refreshRosterForConnection).toHaveBeenCalledTimes(1);
  });

  it('records a successful syncRun under the students source', async () => {
    await task.execute();

    expect(mockSyncRunService.openRun).toHaveBeenCalledWith('students', 'conn-1');
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ createdCount: 1, updatedCount: 2 }),
    );
  });

  it('reports the counts it created and updated', async () => {
    const result = await task.execute();

    expect(result.status).toBe('success');
    expect(result.summary).toEqual({
      fetchedCount: 6,
      createdCount: 2,
      updatedCount: 4,
      failedCount: 0,
    });
  });

  it('records a failed run with its error message', async () => {
    mockSessionService.refreshRosterForConnection
      .mockRejectedValueOnce(new Error('upstream 500'))
      .mockResolvedValue({ created: 0, updated: 1, deactivated: 0, year: 2027 });

    const result = await task.execute();

    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ errorMessage: 'upstream 500' }),
    );
    expect(result.status).toBe('failed');
    expect(result.errorMessages).toContain('upstream 500');
  });

  it('keeps going to the next connection after one fails', async () => {
    mockSessionService.refreshRosterForConnection
      .mockRejectedValueOnce(new Error('upstream 500'))
      .mockResolvedValue({ created: 0, updated: 1, deactivated: 0, year: 2027 });

    await task.execute();

    expect(mockSessionService.refreshRosterForConnection).toHaveBeenCalledTimes(2);
  });

  it('succeeds with no work when there are no active connections', async () => {
    mockPrisma.householdConnection.findMany.mockResolvedValue([]);

    const result = await task.execute();

    expect(result.status).toBe('success');
    expect(result.summary.fetchedCount).toBe(0);
    expect(mockSyncRunService.openRun).not.toHaveBeenCalled();
  });

  describe('roster presence sweep', () => {
    it('sweeps once every connection has refreshed successfully', async () => {
      const result = await task.execute();

      expect(mockRosterPresence.sweep).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('success');
    });

    it('counts swept children as deactivated', async () => {
      mockRosterPresence.sweep.mockResolvedValue(2);

      const result = await task.execute();

      // created(1) + updated(2) per connection x2, plus 2 deactivated.
      expect(result.summary.fetchedCount).toBe(8);
    });

    // A child at a second school is absent from the first school's roster, so
    // a sweep on partial evidence would deactivate them wrongly.
    it('does not sweep when any connection failed', async () => {
      mockSessionService.refreshRosterForConnection
        .mockResolvedValueOnce({ created: 1, updated: 2, deactivated: 0, year: 2027 })
        .mockRejectedValueOnce(new Error('403 from Mashov'));

      const result = await task.execute();

      expect(mockRosterPresence.sweep).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
    });

    it('does not sweep a connection-scoped run', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([
        { id: 'conn-2', schoolCode: 5678, schoolYear: 2027 },
      ]);

      await task.execute({ connectionId: 'conn-2' });

      expect(mockRosterPresence.sweep).not.toHaveBeenCalled();
    });

    it('does not sweep when there are no connections at all', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([]);

      await task.execute();

      expect(mockRosterPresence.sweep).not.toHaveBeenCalled();
    });

    it('still reports success when the sweep itself throws', async () => {
      mockRosterPresence.sweep.mockRejectedValue(new Error('db gone'));

      const result = await task.execute();

      expect(result.status).toBe('success');
    });
  });
});
