import * as crypto from 'crypto';
import { NotificationsTask } from './notifications.task';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { SyncRun } from '@prisma/client';

// Helper to compute the expected fingerprint for an ID-less notification
function computeFingerprint(userId: string, eventType: number, eventTime: string): string {
  const dateKey = new Date(eventTime).toISOString().split('T')[0];
  return crypto.createHash('sha256').update(`${userId}:${eventType}:${dateKey}`).digest('hex');
}

describe('NotificationsTask — deduplication fingerprint', () => {
  let task: NotificationsTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'get'>>;
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
    errorMessage: null,
    householdConnectionId: null,
  } as unknown as SyncRun;

  beforeEach(() => {
    mockMashovClient = {
      get: jest.fn(),
    };
    mockPrisma = {
      notificationEvent: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['notificationEvent']>,
      householdConnection: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      (mockPrisma.notificationEvent.upsert as jest.Mock).mockResolvedValue({ id: 'local-1' });

      await task.execute();

      expect(mockPrisma.notificationEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { upstreamNotificationId: 42 },
        }),
      );
      expect(mockPrisma.notificationEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.notificationEvent.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fingerprint: expect.anything() }) }),
      );
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
      (mockPrisma.notificationEvent.upsert as jest.Mock).mockResolvedValue({ id: 'local-2' });

      await task.execute();

      expect(mockPrisma.notificationEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { upstreamNotificationId: 99 },
        }),
      );
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
      (mockPrisma.notificationEvent.upsert as jest.Mock)
        .mockRejectedValueOnce(new Error('constraint error'))
        .mockResolvedValueOnce({ id: 'local-6' });

      await expect(task.execute()).resolves.not.toThrow();

      expect(mockPrisma.notificationEvent.upsert).toHaveBeenCalledTimes(2);
      expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
        fakeSyncRun.id,
        'success',
        expect.anything(),
      );
    });
  });
});
