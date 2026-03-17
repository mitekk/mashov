import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppSessionService } from './app-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const mockPrisma = {
  appSession: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  expire: jest.fn(),
};

const mockConfig = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'SESSION_LIFETIME_DAYS') return '30';
    return undefined;
  }),
};

describe('AppSessionService', () => {
  let service: AppSessionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppSessionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchedulerRegistry, useValue: { addCronJob: jest.fn() } },
      ],
    }).compile();

    service = module.get<AppSessionService>(AppSessionService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createSession', () => {
    it('creates DB record and caches in Redis, returns token', async () => {
      mockPrisma.appSession.create.mockResolvedValue({});
      mockRedis.set.mockResolvedValue('OK');

      const token = await service.createSession('user-1');

      expect(typeof token).toBe('string');
      expect(token).toHaveLength(64); // 32 bytes hex
      expect(mockPrisma.appSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', sessionToken: token }),
        }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        `session:${token}`,
        expect.any(String),
        300,
      );
    });
  });

  describe('validateSession', () => {
    it('returns userId from Redis cache hit (not expired)', async () => {
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      mockRedis.get.mockResolvedValue(JSON.stringify({ userId: 'user-1', expiresAt }));
      mockRedis.expire.mockResolvedValue(1);
      mockPrisma.appSession.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.validateSession('tok-abc');
      expect(result).toBe('user-1');
      expect(mockRedis.expire).toHaveBeenCalledWith('session:tok-abc', 300);
    });

    it('returns null for expired cache entry, deletes key', async () => {
      const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
      mockRedis.get.mockResolvedValue(JSON.stringify({ userId: 'user-1', expiresAt }));
      mockRedis.del.mockResolvedValue(1);
      mockPrisma.appSession.findUnique.mockResolvedValue(null);

      const result = await service.validateSession('tok-expired');
      expect(result).toBeNull();
      expect(mockRedis.del).toHaveBeenCalledWith('session:tok-expired');
    });

    it('falls back to DB on cache miss and repopulates cache', async () => {
      mockRedis.get.mockResolvedValue(null);
      const expiresAt = new Date(Date.now() + 86400_000);
      mockPrisma.appSession.findUnique.mockResolvedValue({
        sessionToken: 'tok-db',
        userId: 'user-2',
        expiresAt,
        revokedAt: null,
      });
      mockRedis.set.mockResolvedValue('OK');
      mockPrisma.appSession.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.validateSession('tok-db');
      expect(result).toBe('user-2');
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('returns null when DB session not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.appSession.findUnique.mockResolvedValue(null);

      const result = await service.validateSession('tok-missing');
      expect(result).toBeNull();
    });

    it('returns null when session is revoked', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.appSession.findUnique.mockResolvedValue({
        sessionToken: 'tok-revoked',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: new Date(),
      });
      mockRedis.del.mockResolvedValue(1);

      const result = await service.validateSession('tok-revoked');
      expect(result).toBeNull();
    });

    it('handles corrupt cache entry and falls back to DB', async () => {
      mockRedis.get.mockResolvedValue('not-valid-json{{');
      mockRedis.del.mockResolvedValue(1);
      mockPrisma.appSession.findUnique.mockResolvedValue(null);

      const result = await service.validateSession('tok-corrupt');
      expect(result).toBeNull();
    });
  });

  describe('revokeSession', () => {
    it('marks session revoked in DB and deletes Redis key', async () => {
      mockPrisma.appSession.updateMany.mockResolvedValue({ count: 1 });
      mockRedis.del.mockResolvedValue(1);

      await service.revokeSession('tok-xyz');

      expect(mockPrisma.appSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionToken: 'tok-xyz', revokedAt: null },
        }),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('session:tok-xyz');
    });
  });

  describe('revokeAllSessionsForUser', () => {
    it('revokes all user sessions and clears Redis', async () => {
      mockPrisma.appSession.findMany.mockResolvedValue([
        { sessionToken: 'tok-a' },
        { sessionToken: 'tok-b' },
      ]);
      mockPrisma.appSession.updateMany.mockResolvedValue({ count: 2 });
      mockRedis.del.mockResolvedValue(1);

      await service.revokeAllSessionsForUser('user-1');

      expect(mockPrisma.appSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('session:tok-a');
      expect(mockRedis.del).toHaveBeenCalledWith('session:tok-b');
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('deletes sessions revoked more than 7 days ago', async () => {
      mockPrisma.appSession.deleteMany.mockResolvedValue({ count: 3 });

      await service.cleanupExpiredSessions();

      expect(mockPrisma.appSession.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { revokedAt: expect.objectContaining({ not: null }) },
        }),
      );
    });

    it('handles cleanup errors gracefully', async () => {
      mockPrisma.appSession.deleteMany.mockRejectedValue(new Error('DB error'));
      await expect(service.cleanupExpiredSessions()).resolves.not.toThrow();
    });
  });
});
