import * as crypto from 'crypto';
import { NotificationsTask } from './notifications.task';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { SyncRun } from '@prisma/client';

/**
 * The expected fingerprint for an ID-less notification.
 *
 * The owning connection is part of the hash input rather than of a new index:
 * `fingerprint` stays uniquely indexed on its own and the two schools' hashes
 * simply differ. `'shared'` is the shared env-session's stand-in, which has no
 * connection.
 */
function computeFingerprint(
  userId: string,
  eventType: number,
  eventTime: string,
  connectionId = 'shared',
): string {
  const dateKey = new Date(eventTime).toISOString().split('T')[0];
  return crypto
    .createHash('sha256')
    .update(`${connectionId}:${userId}:${eventType}:${dateKey}`)
    .digest('hex');
}

describe('NotificationsTask — deduplication fingerprint', () => {
  let task: NotificationsTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'get' | 'getForConnection'>>;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'notificationEvent' | 'householdConnection'>>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun'>>;
  let mockEncryptionService: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  const fakeSyncRun: SyncRun = {
    id: 'run-1',
    source: 'notifications',
    status: 'running',
    startedAt: new Date(),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
  } as unknown as SyncRun;

  beforeEach(() => {
    mockMashovClient = {
      get: jest.fn(),
      getForConnection: jest.fn(),
    };
    mockPrisma = {
      notificationEvent: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        // The shared env session owns no connection, and a NULL cannot be
        // looked up through a unique index, so that path is find-then-write.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['notificationEvent']>,
      householdConnection: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      } as unknown as jest.Mocked<PrismaService['householdConnection']>,
    };
    mockSyncRunService = {
      openRun: jest.fn().mockResolvedValue(fakeSyncRun),
      closeRun: jest.fn().mockResolvedValue(fakeSyncRun),
    };
    mockEncryptionService = {
      decrypt: jest.fn().mockReturnValue('decrypted-password'),
    };

    task = new NotificationsTask(
      mockMashovClient as unknown as MashovHttpClient,
      mockPrisma as unknown as PrismaService,
      mockSyncRunService as unknown as SyncRunService,
      mockEncryptionService as unknown as EncryptionService,
    );
  });

  describe('notifications with a stable upstream ID', () => {
    it('upserts by upstreamNotificationId when the notification has an id', async () => {
      const notification = {
        id: 42,
        userId: 'user-1',
        eventTime: '2026-01-15T10:00:00Z',
        eventType: 10,
        eventText: 'Homework not completed',
        isNew: true,
      };

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findFirst as jest.Mock).mockResolvedValue({ id: 'local-1' });

      await task.execute();

      // On the shared env-session path the row has no owner, and a NULL
      // cannot be looked up through a unique index, so the id lookup is
      // find-then-write rather than an upsert. Same observable behaviour.
      expect(mockPrisma.notificationEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { householdConnectionId: null, upstreamNotificationId: 42 },
        }),
      );
      expect(mockPrisma.notificationEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'local-1' } }),
      );
      expect(mockPrisma.notificationEvent.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fingerprint: expect.anything() }) }),
      );
    });

    it('keys on the owning connection when one is active', async () => {
      // Two schools collide on upstreamNotificationId -- it is a per-school
      // counter -- so the id alone meant the second school's notification
      // silently replaced the first's.
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'conn-a',
          schoolCode: 540175,
          schoolYear: 2026,
          username: 'parent-a',
          encryptedPassword: 'enc',
        },
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue([
        {
          id: 42,
          userId: 'user-1',
          eventTime: '2026-01-15T10:00:00Z',
          eventType: 10,
          eventText: 'Homework not completed',
        },
      ]);
      (mockPrisma.notificationEvent.upsert as jest.Mock).mockResolvedValue({ id: 'local-1' });

      await task.execute();

      expect(mockPrisma.notificationEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            householdConnectionId_upstreamNotificationId: {
              householdConnectionId: 'conn-a',
              upstreamNotificationId: 42,
            },
          },
        }),
      );
    });

    it('does not let two schools sharing an upstream id collide', async () => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        { id: 'conn-a', schoolCode: 540175, schoolYear: 2026, username: 'a', encryptedPassword: 'e' },
        { id: 'conn-b', schoolCode: 999999, schoolYear: 2027, username: 'b', encryptedPassword: 'e' },
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue([
        {
          id: 7,
          userId: 'user-1',
          eventTime: '2026-01-15T10:00:00Z',
          eventType: 10,
          eventText: 'Same upstream id at both schools',
        },
      ]);
      (mockPrisma.notificationEvent.upsert as jest.Mock).mockResolvedValue({ id: 'local' });

      await task.execute();

      const keys = (mockPrisma.notificationEvent.upsert as jest.Mock).mock.calls.map(
        (call) => call[0].where.householdConnectionId_upstreamNotificationId,
      );
      expect(keys).toEqual([
        { householdConnectionId: 'conn-a', upstreamNotificationId: 7 },
        { householdConnectionId: 'conn-b', upstreamNotificationId: 7 },
      ]);
    });

    it('gives the two schools different fingerprints for the same ID-less event', async () => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        { id: 'conn-a', schoolCode: 540175, schoolYear: 2026, username: 'a', encryptedPassword: 'e' },
        { id: 'conn-b', schoolCode: 999999, schoolYear: 2027, username: 'b', encryptedPassword: 'e' },
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue([
        {
          userId: 'user-1',
          eventTime: '2026-01-15T10:00:00Z',
          eventType: 16,
          eventText: 'Parent evening',
        },
      ]);
      (mockPrisma.notificationEvent.findUnique as jest.Mock).mockResolvedValue(null);

      await task.execute();

      const fingerprints = (mockPrisma.notificationEvent.create as jest.Mock).mock.calls.map(
        (call) => call[0].data.fingerprint,
      );
      expect(fingerprints).toEqual([
        computeFingerprint('user-1', 16, '2026-01-15T10:00:00Z', 'conn-a'),
        computeFingerprint('user-1', 16, '2026-01-15T10:00:00Z', 'conn-b'),
      ]);
      expect(fingerprints[0]).not.toBe(fingerprints[1]);
    });

    it('does not compute a fingerprint when the notification has an id', async () => {
      const notification = {
        id: 99,
        userId: 'user-1',
        eventTime: '2026-01-15T10:00:00Z',
        eventType: 16,
        eventText: 'Parent evening',
      };

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findFirst as jest.Mock).mockResolvedValue(null);

      await task.execute();

      expect(mockPrisma.notificationEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ upstreamNotificationId: 99 }),
        }),
      );
      expect(mockPrisma.notificationEvent.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('eventType 16 — ID-less notifications', () => {
    it('computes fingerprint as sha256(userId:eventType:date) for notifications without an id', async () => {
      const userId = 'user-abc';
      const eventTime = '2026-03-10T08:30:00Z';
      const eventType = 16;

      const notification = {
        // no `id` field
        userId,
        eventTime,
        eventType,
        eventText: 'Parent evening notification',
        isNew: false,
      };

      const expectedFingerprint = computeFingerprint(userId, eventType, eventTime);

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.notificationEvent.create as jest.Mock).mockResolvedValue({ id: 'local-3' });

      await task.execute();

      expect(mockPrisma.notificationEvent.findUnique).toHaveBeenCalledWith({
        where: { fingerprint: expectedFingerprint },
      });
      expect(mockPrisma.notificationEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fingerprint: expectedFingerprint }),
        }),
      );
    });

    it('creates a new notification when fingerprint does not exist in DB', async () => {
      const notification = {
        userId: 'user-abc',
        eventTime: '2026-03-10T08:00:00Z',
        eventType: 16,
        eventText: 'New notification',
      };

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.notificationEvent.create as jest.Mock).mockResolvedValue({ id: 'local-4' });

      await task.execute();

      expect(mockPrisma.notificationEvent.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notificationEvent.update).not.toHaveBeenCalled();
    });

    it('updates the existing notification when fingerprint already exists in DB', async () => {
      const notification = {
        userId: 'user-abc',
        eventTime: '2026-03-10T08:00:00Z',
        eventType: 16,
        eventText: 'Updated notification text',
      };
      const expectedFingerprint = computeFingerprint('user-abc', 16, '2026-03-10T08:00:00Z');

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing-1',
        fingerprint: expectedFingerprint,
      });
      (mockPrisma.notificationEvent.update as jest.Mock).mockResolvedValue({
        id: 'existing-1',
      });

      await task.execute();

      expect(mockPrisma.notificationEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.notificationEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { fingerprint: expectedFingerprint },
        }),
      );
    });

    it('fingerprint changes when the date portion of eventTime changes (day boundary)', () => {
      const userId = 'user-abc';
      const eventType = 16;

      const fp1 = computeFingerprint(userId, eventType, '2026-03-10T23:59:00Z');
      const fp2 = computeFingerprint(userId, eventType, '2026-03-11T00:01:00Z');

      // Different days must produce different fingerprints
      expect(fp1).not.toBe(fp2);
    });

    it('fingerprint is the same for two times on the same day', () => {
      const userId = 'user-abc';
      const eventType = 16;

      const fp1 = computeFingerprint(userId, eventType, '2026-03-10T08:00:00Z');
      const fp2 = computeFingerprint(userId, eventType, '2026-03-10T20:00:00Z');

      // Same day must produce the same fingerprint (deduplication within a day)
      expect(fp1).toBe(fp2);
    });

    it('fingerprint differs for different users on the same day', () => {
      const eventType = 16;
      const eventTime = '2026-03-10T10:00:00Z';

      const fp1 = computeFingerprint('user-abc', eventType, eventTime);
      const fp2 = computeFingerprint('user-xyz', eventType, eventTime);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('other eventTypes without an id', () => {
    it('deduplicates by fingerprint (not upstreamNotificationId) when there is no id field', async () => {
      const notification = {
        // no id — so fingerprint path is used
        userId: 'user-def',
        eventTime: '2026-03-11T09:00:00Z',
        eventType: 5,
        eventText: 'Did not complete homework',
      };

      (mockMashovClient.get as jest.Mock).mockResolvedValue([notification]);
      (mockPrisma.notificationEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.notificationEvent.create as jest.Mock).mockResolvedValue({ id: 'local-5' });

      await task.execute();

      expect(mockPrisma.notificationEvent.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.notificationEvent.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fingerprint: expect.any(String) }) }),
      );
    });
  });

  describe('error handling', () => {
    it('closes the sync run with failed status when upstream fetch fails', async () => {
      (mockMashovClient.get as jest.Mock).mockRejectedValue(new Error('network timeout'));

      await task.execute();

      expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
        fakeSyncRun.id,
        'failed',
        expect.objectContaining({ errorMessage: 'network timeout' }),
      );
    });

    it('continues processing remaining notifications when a single item fails to upsert', async () => {
      const notifications = [
        { id: 1, userId: 'u1', eventTime: '2026-03-11T10:00:00Z', eventType: 10, eventText: 'first' },
        { id: 2, userId: 'u1', eventTime: '2026-03-11T10:00:00Z', eventType: 10, eventText: 'second' },
      ];

      (mockMashovClient.get as jest.Mock).mockResolvedValue(notifications);
      // The shared env-session path is find-then-write, so the failure has to
      // be injected there rather than on upsert.
      (mockPrisma.notificationEvent.findFirst as jest.Mock)
        .mockRejectedValueOnce(new Error('constraint error'))
        .mockResolvedValueOnce(null);

      await expect(task.execute()).resolves.not.toThrow();

      expect(mockPrisma.notificationEvent.findFirst).toHaveBeenCalledTimes(2);
      expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
        fakeSyncRun.id,
        'success',
        expect.anything(),
      );
    });
  });
  describe('a targeted refresh of a connection that is not usable', () => {
  /**
   * R11: a targeted refresh of a connection that cannot be used.
   *
   * `useSharedSession` is false once `context.connectionId` is set, but the
   * target list is then `[]` if that connection is inactive or has
   * `userId: null`. The loop body never ran, so the task returned
   * `status: 'success'` with every count zero and left no `sync_run` -- a
   * silent success that made a real failure undiagnosable.
   */
  beforeEach(() => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('reports the run as failed rather than a clean sync', async () => {
      const result = await task.execute({ connectionId: 'conn-gone' });

      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBe(1);
    });

    it('opens exactly one run and closes it failed, with the reason', async () => {
      await task.execute({ connectionId: 'conn-gone' });

      expect(mockSyncRunService.openRun).toHaveBeenCalledTimes(1);
      expect(mockSyncRunService.openRun).toHaveBeenCalledWith(expect.any(String), 'conn-gone');
      expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('conn-gone') }),
      );
    });

    it('never reaches upstream', async () => {
      await task.execute({ connectionId: 'conn-gone' });

      expect(mockMashovClient.get).not.toHaveBeenCalled();
      expect(mockMashovClient.getForConnection).not.toHaveBeenCalled();
    });
  });

});
