import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, CanceledError } from 'axios';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppSessionService } from '../app-session/app-session.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// AuthService talks to Mashov through createMashovAxios(), so the assertions
// target the axios *instance* rather than the module-level helpers.
const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

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
    updateMany: jest.fn(),
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
  get: jest.fn().mockImplementation(() => undefined),
};

const mockSchoolYearService = {
  resolveForSchool: jest.fn(),
  reconcileFromLogin: jest.fn(),
  invalidate: jest.fn(),
};

const mockLoginResponse = {
  credential: { userId: 'mashov-uid-1', displayName: 'Test Parent' },
  accessToken: {
    schoolSettings: { schoolName: 'Test School', schoolYear: 2027 },
    children: [],
    username: 'testuser',
    userSettings: { detailsState: 1 },
  },
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.reconcileFromLogin.mockImplementation((candidate: number) => ({
      year: candidate,
      changed: false,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
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
      mockHttp.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
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
      mockHttp.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
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
      mockHttp.post = jest.fn().mockRejectedValue(err);

      await expect(service.login(482273, 'baduser', 'badpass', '127.0.0.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws 401 on an error it cannot classify', async () => {
      mockRedis.incr.mockResolvedValue(1);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      mockHttp.post = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(service.login(482273, 'user', 'pass', '127.0.0.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws 502, not 401, when the request is aborted by the timeout signal', async () => {
      mockRedis.incr.mockResolvedValue(1);
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockHttp.post = jest.fn().mockRejectedValue(new CanceledError('canceled'));

      await expect(
        service.login(482273, 'user', 'pass', '127.0.0.1'),
      ).rejects.toThrow(BadGatewayException);
    });

    it('throws 502, not 401, when Mashov never responds', async () => {
      mockRedis.incr.mockResolvedValue(1);
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockHttp.post = jest
        .fn()
        .mockRejectedValue(new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'));

      await expect(
        service.login(482273, 'user', 'pass', '127.0.0.1'),
      ).rejects.toThrow(BadGatewayException);
    });

    it('still reports invalid credentials when Mashov answers 401', async () => {
      mockRedis.incr.mockResolvedValue(1);
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      const rejected = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
      rejected.response = { status: 401 } as AxiosError['response'];
      mockHttp.post = jest.fn().mockRejectedValue(rejected);

      await expect(
        service.login(482273, 'user', 'pass', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
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
      mockHttp.post = jest.fn().mockResolvedValue({ data: loginWithChildren });
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

    it('stamps the children with the connection it just created', async () => {
      // Sign-in writes the roster itself rather than going through
      // persistRoster, so it needs its own stamp. Without it the first login
      // of a household leaves every child unowned until a sync cron happens to
      // re-stamp them -- and MailInboxTask refuses to reconcile unread while
      // any row is unstamped.
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
      mockHttp.post = jest.fn().mockResolvedValue({ data: loginWithChildren });
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.householdConnection.create.mockResolvedValue({ id: 'conn-new' });
      mockPrisma.student.upsert.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      const [{ create, update }] = mockPrisma.student.upsert.mock.calls[0] as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ];
      expect(create.householdConnectionId).toBe('conn-new');
      expect(update.householdConnectionId).toBe('conn-new');
    });

    it('stamps the children with the existing connection on a return login', async () => {
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
          inactiveChildren: [{ childGuid: 'child-gone' }],
        },
      };
      mockHttp.post = jest.fn().mockResolvedValue({ data: loginWithChildren });
      mockPrisma.appUser.findUnique.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue({
        id: 'conn-existing',
        mashovUniqueId: 'uniq-0',
      });
      mockPrisma.householdConnection.update.mockResolvedValue({ id: 'conn-existing' });
      mockPrisma.student.upsert.mockResolvedValue({});
      mockPrisma.student.updateMany.mockResolvedValue({ count: 1 });
      mockRedis.incr.mockResolvedValue(1);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      const [{ update }] = mockPrisma.student.upsert.mock.calls[0] as [
        { update: Record<string, unknown> },
      ];
      expect(update.householdConnectionId).toBe('conn-existing');
      // The deactivation sweep is scoped the same way persistRoster's is: one
      // school must not be able to retire a child it does not own.
      expect(mockPrisma.student.updateMany).toHaveBeenCalledWith({
        where: {
          studentGuid: { in: ['child-gone'] },
          OR: [
            { householdConnectionId: 'conn-existing' },
            { householdConnectionId: null },
          ],
        },
        data: { isActive: false },
      });
    });
  });

  describe('school year resolution', () => {
    function arrangeSuccessfulLogin(data: unknown = mockLoginResponse) {
      mockHttp.post = jest.fn().mockResolvedValue({ data });
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.householdConnection.create.mockResolvedValue({ id: 'conn-new' });
      mockPrisma.householdConnection.update.mockResolvedValue({ id: 'conn-existing' });
      mockPrisma.student.upsert.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);
    }

    it('sends the resolved year in the login body', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.resolveForSchool).toHaveBeenCalledWith(482273);
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2027 }),
        expect.anything(),
      );
    });

    it('finds the existing connection by school and username rather than by year', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue({ id: 'conn-1' });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      for (const call of mockPrisma.householdConnection.findFirst.mock.calls) {
        expect(call[0].where).not.toHaveProperty('schoolYear');
        expect(call[0].where).toMatchObject({ schoolCode: 482273, username: 'user' });
      }
    });

    it("advances an existing connection's schoolYear", async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue({
        id: 'conn-1',
        schoolYear: 2026,
      });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conn-1' },
          data: expect.objectContaining({ schoolYear: 2027 }),
        }),
      );
    });

    it('persists the year Mashov reports when it differs from the one sent', async () => {
      arrangeSuccessfulLogin({
        ...mockLoginResponse,
        accessToken: {
          ...mockLoginResponse.accessToken,
          schoolSettings: { schoolName: 'Test School', schoolYear: 2026 },
        },
      });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockSchoolYearService.reconcileFromLogin.mockReturnValue({ year: 2026, changed: true });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.householdConnection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYear: 2026 }),
        }),
      );
    });

    it('invalidates the cached resolved year when Mashov vetoes it', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockSchoolYearService.reconcileFromLogin
        .mockReturnValueOnce({ year: 2026, changed: true })
        .mockReturnValue({ year: 2026, changed: false });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.invalidate).toHaveBeenCalledWith(482273);
    });

    it('re-logs in once when Mashov reports a different active year', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockSchoolYearService.reconcileFromLogin
        .mockReturnValueOnce({ year: 2026, changed: true })
        .mockReturnValue({ year: 2026, changed: false });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
      expect(mockHttp.post).toHaveBeenLastCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2026 }),
        expect.anything(),
      );
    });

    it('does not re-login more than once even if the year still disagrees', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockSchoolYearService.reconcileFromLogin.mockReturnValue({ year: 2026, changed: true });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
    });

    it('keeps the first login when the reconcile re-login is rejected', async () => {
      // The parent's password is correct — Mashov simply has no enrolment in
      // the year it just named, or rate-limited two logins in one second.
      // Failing the whole sign-in would send them off to retype a password
      // that was right, which is the lie this file exists to avoid.
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-1' });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.householdConnection.create.mockResolvedValue({});
      mockPrisma.student.upsert.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);
      mockSchoolYearService.reconcileFromLogin.mockReturnValue({
        year: 2026,
        changed: true,
      });

      const rejected = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
      rejected.response = { status: 401 } as AxiosError['response'];
      mockHttp.post = jest
        .fn()
        .mockResolvedValueOnce({ data: mockLoginResponse })
        .mockRejectedValueOnce(rejected);

      const result = await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(result.sessionToken).toBe('session-token-abc');
      // Falls back to the year that actually worked, not the rejected one.
      expect(mockPrisma.householdConnection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYear: 2027 }),
        }),
      );
    });

    it('still fails the sign-in when the FIRST login is rejected', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const rejected = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
      rejected.response = { status: 401 } as AxiosError['response'];
      mockHttp.post = jest.fn().mockRejectedValue(rejected);

      await expect(
        service.login(482273, 'user', 'badpass', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('updates classCode and classNum for a child who moved up a grade', async () => {
      arrangeSuccessfulLogin({
        ...mockLoginResponse,
        accessToken: {
          ...mockLoginResponse.accessToken,
          children: [
            {
              childGuid: 'child-1',
              familyName: 'Cohen',
              privateName: 'Avi',
              classCode: 'ז',
              classNum: 3,
              gender: 'M',
              groups: [1],
            },
          ],
        },
      });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: 'child-1' },
          update: expect.objectContaining({ classCode: 'ז', classNum: 3 }),
        }),
      );
    });

    it('marks children Mashov reports as inactive as inactive', async () => {
      arrangeSuccessfulLogin({
        ...mockLoginResponse,
        accessToken: {
          ...mockLoginResponse.accessToken,
          children: [],
          inactiveChildren: [{ childGuid: 'child-gone' }],
        },
      });
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.student.updateMany.mockResolvedValue({ count: 1 });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.student.updateMany).toHaveBeenCalledWith({
        where: {
          studentGuid: { in: ['child-gone'] },
          // Scoped as of the ownership stamp: `inactiveChildren` is
          // school-local, so a login must not retire a child another school
          // owns. NULL is included because it means "ownership unknown".
          OR: [{ householdConnectionId: 'conn-new' }, { householdConnectionId: null }],
        },
        data: { isActive: false },
      });
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
