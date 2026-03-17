import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppSessionService } from '../app-session/app-session.service';
import { EncryptionService } from '../session/encryption.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  appUser: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  householdConnection: {
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  student: {
    upsert: jest.fn(),
  },
};

const mockRedis = {
  incr: jest.fn(),
  expire: jest.fn(),
};

const mockAppSessionService = {
  createSession: jest.fn().mockResolvedValue('session-token-abc'),
};

const mockEncryptionService = {
  encrypt: jest.fn().mockReturnValue('encrypted-pw'),
  decrypt: jest.fn().mockReturnValue('plaintext-pw'),
};

const mockConfig = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'MASHOV_YEAR') return '2026';
    return undefined;
  }),
};

const mockLoginResponse = {
  credential: { userId: 'mashov-uid-1', displayName: 'Test Parent' },
  accessToken: {
    schoolSettings: { schoolName: 'Test School', schoolYear: 2026 },
    children: [],
    username: 'testuser',
    userSettings: { detailsState: 1 },
  },
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('checkRateLimit', () => {
    it('increments counter and sets expiry on first attempt', async () => {
      mockRedis.incr.mockResolvedValue(1);
      await expect(service.checkRateLimit('1.2.3.4')).resolves.not.toThrow();
      expect(mockRedis.expire).toHaveBeenCalledWith('ratelimit:login:1.2.3.4', 900);
    });

    it('allows up to 5 attempts', async () => {
      mockRedis.incr.mockResolvedValue(5);
      await expect(service.checkRateLimit('1.2.3.4')).resolves.not.toThrow();
    });

    it('throws on 6th attempt', async () => {
      mockRedis.incr.mockResolvedValue(6);
      await expect(service.checkRateLimit('1.2.3.4')).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it('does not reset expiry on subsequent attempts', async () => {
      mockRedis.incr.mockResolvedValue(3);
      await service.checkRateLimit('1.2.3.4');
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('returns sessionToken and isFirstLogin=true for new user', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1', mashovUserId: 'mashov-uid-1', username: 'test', displayName: 'Test' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.householdConnection.create.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);

      const result = await service.login(482273, 'testuser', 'pass', '127.0.0.1');

      expect(result.isFirstLogin).toBe(true);
      expect(result.sessionToken).toBe('session-token-abc');
    });

    it('returns isFirstLogin=false for existing user', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
      mockPrisma.appUser.findUnique.mockResolvedValue({ id: 'existing-user' });
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'existing-user', mashovUserId: 'mashov-uid-1', username: 'test', displayName: 'Test' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue({ id: 'conn-1' });
      mockPrisma.householdConnection.update.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);

      const result = await service.login(482273, 'testuser', 'pass', '127.0.0.1');

      expect(result.isFirstLogin).toBe(false);
    });

    it('throws 401 on Mashov 401 response', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const err = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockedAxios.post = jest.fn().mockRejectedValue(err);

      await expect(service.login(482273, 'baduser', 'badpass', '127.0.0.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws 401 on network error', async () => {
      mockRedis.incr.mockResolvedValue(1);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(service.login(482273, 'user', 'pass', '127.0.0.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('persists children from login response', async () => {
      const loginWithChildren = {
        ...mockLoginResponse,
        accessToken: {
          ...mockLoginResponse.accessToken,
          children: [
            {
              childGuid: 'child-1',
              familyName: 'Cohen',
              privateName: 'Avi',
              classCode: '10A',
              classNum: 10,
              gender: 'M',
              groups: [1, 2],
            },
          ],
        },
      };
      mockedAxios.post = jest.fn().mockResolvedValue({ data: loginWithChildren });
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.householdConnection.create.mockResolvedValue({});
      mockPrisma.student.upsert.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: 'child-1' },
        }),
      );
    });
  });

  describe('getMe', () => {
    it('returns user info with connected school', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'Test Parent',
      });
      mockPrisma.householdConnection.findFirst.mockResolvedValue({
        schoolName: 'My School',
        schoolYear: 2026,
      });

      const result = await service.getMe('user-1');

      expect(result.connectedSchool).toEqual({ schoolName: 'My School', schoolYear: 2026 });
      expect(result.username).toBe('test');
    });

    it('throws 401 when user not found', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      await expect(service.getMe('ghost')).rejects.toThrow(UnauthorizedException);
    });

    it('returns null connectedSchool when no active connection', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue({ id: 'u1', mashovUserId: 'm1', username: 'u', displayName: 'U' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);

      const result = await service.getMe('u1');
      expect(result.connectedSchool).toBeNull();
    });
  });
});
