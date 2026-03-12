import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SessionService } from '../../src/session/session.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EncryptionService } from '../../src/session/encryption.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrismaService = {
  student: {
    upsert: jest.fn(),
  },
  householdConnection: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const mockConfigService = {
  get: jest.fn((key: string) => {
    const config: Record<string, string | number> = {
      MASHOV_SEMEL: 482273,
      MASHOV_YEAR: 2026,
      MASHOV_USERNAME: 'testuser',
      MASHOV_PASSWORD: 'testpass',
    };
    return config[key];
  }),
};

const mockEncryptionService = {
  encrypt: jest.fn().mockReturnValue('encrypted_password'),
};

const loginResponse = {
  credential: {
    userId: 'user-123',
    displayName: 'Test Parent',
    semel: 482273,
    year: 2026,
  },
  accessToken: {
    userSettings: { detailsState: 1 },
    schoolSettings: { schoolName: 'Test School', schoolYear: 2026 },
    children: [
      {
        childGuid: 'child-guid-1',
        privateName: 'Test',
        familyName: 'Child',
        classCode: '7A',
        classNum: 7,
        gender: 'M',
        groups: [1, 2, 3],
      },
    ],
    username: 'testuser',
  },
};

describe('SessionService', () => {
  let service: SessionService;
  let mockHttpInstance: jest.Mocked<ReturnType<typeof axios.create>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockHttpInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
    } as unknown as jest.Mocked<ReturnType<typeof axios.create>>;

    mockedAxios.create = jest.fn().mockReturnValue(mockHttpInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EncryptionService, useValue: mockEncryptionService },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  describe('login', () => {
    it('calls login POST with correct body shape', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': [
            'Csrf-Token=csrf-abc; Path=/',
            'MashovAuthToken=auth-abc; Path=/',
            'uniquId=uniq-abc; Path=/',
          ],
        },
      });

      mockPrismaService.student.upsert.mockResolvedValue({});
      mockPrismaService.householdConnection.findFirst.mockResolvedValue(null);
      mockPrismaService.householdConnection.create.mockResolvedValue({});

      await service.login();

      expect(mockHttpInstance.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({
          semel: 482273,
          year: 2026,
          username: 'testuser',
          password: 'testpass',
          appName: 'info.mashov.students',
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Csrf-Token': '9c690c16-d0c8-ed43-9314-d622077e2e26',
            'Content-Type': 'application/json',
            'Referer': 'https://web.mashov.info/students/login',
            'sec-ch-ua-platform': '"macOS"',
            'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
          }),
        }),
      );
      expect(mockHttpInstance.get).not.toHaveBeenCalled();
    });

    it('sends fixed X-Csrf-Token header', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': [
            'Csrf-Token=csrf-abc; Path=/',
            'MashovAuthToken=auth-abc; Path=/',
            'uniquId=uniq-abc; Path=/',
          ],
        },
      });

      mockPrismaService.student.upsert.mockResolvedValue({});
      mockPrismaService.householdConnection.findFirst.mockResolvedValue(null);
      mockPrismaService.householdConnection.create.mockResolvedValue({});

      await service.login();

      const [, , config] = mockHttpInstance.post.mock.calls[0];
      expect(config?.headers?.['X-Csrf-Token']).toBe(
        '9c690c16-d0c8-ed43-9314-d622077e2e26',
      );
    });

    it('stores cookies after successful login', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': [
            'Csrf-Token=csrf-val; Path=/',
            'MashovAuthToken=auth-val; Path=/',
            'uniquId=uniq-val; Path=/',
          ],
        },
      });

      mockPrismaService.student.upsert.mockResolvedValue({});
      mockPrismaService.householdConnection.findFirst.mockResolvedValue(null);
      mockPrismaService.householdConnection.create.mockResolvedValue({});

      await service.login();

      expect(service.isSessionValid()).toBe(true);
    });

    it('throws when required session cookies are missing from login response', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': ['OnlyOneCookie=value; Path=/'],
        },
      });

      await expect(service.login()).rejects.toThrow('Missing required session cookies');
    });
  });

  describe('getAuthHeaders', () => {
    it('re-authenticates and returns headers when session is not initialized', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': [
            'Csrf-Token=fresh-csrf; Path=/',
            'MashovAuthToken=fresh-auth; Path=/',
            'uniquId=fresh-uniq; Path=/',
          ],
        },
      });

      mockPrismaService.student.upsert.mockResolvedValue({});
      mockPrismaService.householdConnection.findFirst.mockResolvedValue(null);
      mockPrismaService.householdConnection.create.mockResolvedValue({});

      const headers = await service.getAuthHeaders();

      expect(headers).toHaveProperty('X-Csrf-Token');
      expect(headers).toHaveProperty('Cookie');
      expect(headers['Cookie']).toContain('MashovAuthToken=fresh-auth');
    });
  });

  describe('refreshIfExpired', () => {
    it('clears session state and triggers re-authentication on 401', async () => {
      mockHttpInstance.post.mockResolvedValueOnce({
        data: loginResponse,
        headers: {
          'set-cookie': [
            'Csrf-Token=refreshed-csrf; Path=/',
            'MashovAuthToken=refreshed-auth; Path=/',
            'uniquId=refreshed-uniq; Path=/',
          ],
        },
      });

      mockPrismaService.student.upsert.mockResolvedValue({});
      mockPrismaService.householdConnection.findFirst.mockResolvedValue(null);
      mockPrismaService.householdConnection.create.mockResolvedValue({});

      await service.refreshIfExpired();

      expect(service.isSessionValid()).toBe(true);
      expect(mockHttpInstance.post).toHaveBeenCalledTimes(1);
    });
  });
});
