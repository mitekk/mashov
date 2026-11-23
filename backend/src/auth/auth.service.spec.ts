import {
  BadGatewayException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, CanceledError } from 'axios';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppSessionService } from '../app-session/app-session.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { SchoolLinksService } from '../school-links/school-links.service';
// Real, not mocked: it is the single `POST /api/login` now, and it builds its
// client with the same `createMashovAxios` the spec already stubs, so the
// `mockHttp.post` assertions below still see every login body AuthService sends.
import { MashovCredentialValidatorService } from '../common/mashov-login/mashov-credential-validator.service';

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
    // (schoolCode, username) is a unique key now, so the identity lookup is a
    // findUnique. findFirst stays for the paths that still use it.
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  student: {
    upsert: jest.fn(),
    updateMany: jest.fn(),
    // `getMe`'s children count, over the same predicate GET /children uses.
    count: jest.fn().mockResolvedValue(0),
  },
  studentConnection: {
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
  get: jest.fn().mockImplementation(() => undefined),
};

const mockSchoolLinksService = {
  // One method feeds both GET /school-links and me.schools, so the two can
  // never disagree about which schools a household has.
  listLinks: jest.fn().mockResolvedValue([]),
  listMeSchools: jest.fn().mockResolvedValue([]),
};

const mockSchoolYearService = {
  resolveForSchool: jest.fn(),
  reconcileFromLogin: jest.fn(),
  invalidate: jest.fn(),
  schoolNameFor: jest.fn(),
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
    mockSchoolLinksService.listMeSchools.mockResolvedValue([]);
    mockPrisma.student.count.mockResolvedValue(0);
    mockPrisma.householdConnection.findMany.mockResolvedValue([]);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.schoolNameFor.mockResolvedValue(null);
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
        { provide: SchoolLinksService, useValue: mockSchoolLinksService },
        MashovCredentialValidatorService,
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue({ id: 'conn-1' });
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue({
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
      // And the login grants that connection a VIEW of the child, which is
      // the half the stamp cannot do: two parents at one school both list the
      // same children, so visibility has to be a set (ADR-0031).
      expect(mockPrisma.studentConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            studentGuid_householdConnectionId: {
              studentGuid: 'child-1',
              householdConnectionId: 'conn-existing',
            },
          },
        }),
      );
      // The deactivation sweep is scoped the same way persistRoster's is: one
      // school must not be able to retire a child it does not list. Since
      // ADR-0031 that is a link rather than the routing stamp, because a child
      // two parents share is stamped to only one of them.
      expect(mockPrisma.student.updateMany).toHaveBeenCalledWith({
        where: {
          studentGuid: { in: ['child-gone'] },
          OR: [
            { links: { some: { householdConnectionId: 'conn-existing' } } },
            { links: { none: {} } },
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.resolveForSchool).toHaveBeenCalledWith(482273);
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2027 }),
        expect.anything(),
      );
    });

    it("falls back to the public school list's name when the login omits one", async () => {
      // T13 finding 1, and the path it was actually observed on: school B's
      // sign-in. `schoolSettings.schoolName` is absent, so the column was
      // stored NULL and the `?? String(schoolCode)` fallbacks downstream made
      // the chip and the contact card read `484121`. The name is in the public
      // list `GET /auth/schools` already serves to populate the sign-in picker.
      arrangeSuccessfulLogin({
        credential: { userId: 'mashov-uid-1', displayName: 'Test Parent' },
        accessToken: {
          schoolSettings: { schoolYear: 2027 },
          children: [],
          username: 'testuser',
          userSettings: { detailsState: 1 },
        },
      });
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
      mockSchoolYearService.schoolNameFor.mockResolvedValue(
        'חטיבת נעורים בראשית - צור יצחק (חטב)',
      );

      await service.login(484121, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.schoolNameFor).toHaveBeenCalledWith(484121);
      expect(mockPrisma.householdConnection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            schoolName: 'חטיבת נעורים בראשית - צור יצחק (חטב)',
          }),
        }),
      );
    });

    it('does not look up a name the login already carries', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.schoolNameFor).not.toHaveBeenCalled();
      expect(mockPrisma.householdConnection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolName: 'Test School' }),
        }),
      );
    });

    it('stores undefined when neither source has a name, leaving a stored one alone', async () => {
      // Prisma leaves a field alone on `undefined`, so the fallback can never
      // downgrade a good name already stored.
      arrangeSuccessfulLogin({
        credential: { userId: 'mashov-uid-1', displayName: 'Test Parent' },
        accessToken: {
          schoolSettings: { schoolYear: 2027 },
          children: [],
          username: 'testuser',
          userSettings: { detailsState: 1 },
        },
      });
      mockPrisma.householdConnection.findUnique.mockResolvedValue({ id: 'conn-1' });

      await service.login(484121, 'user', 'pass', '127.0.0.1');

      const call = mockPrisma.householdConnection.update.mock.calls.at(-1) as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data.schoolName).toBeUndefined();
    });

    it('finds the existing connection by school and username rather than by year', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findUnique.mockResolvedValue({ id: 'conn-1' });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      for (const call of mockPrisma.householdConnection.findFirst.mock.calls) {
        expect(call[0].where).not.toHaveProperty('schoolYear');
        expect(call[0].where).toMatchObject({ schoolCode: 482273, username: 'user' });
      }
    });

    it("advances an existing connection's schoolYear", async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findUnique.mockResolvedValue({
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
      mockSchoolYearService.reconcileFromLogin
        .mockReturnValueOnce({ year: 2026, changed: true })
        .mockReturnValue({ year: 2026, changed: false });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockSchoolYearService.invalidate).toHaveBeenCalledWith(482273);
    });

    it('re-logs in once when Mashov reports a different active year', async () => {
      arrangeSuccessfulLogin();
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

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
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
      mockPrisma.student.updateMany.mockResolvedValue({ count: 1 });

      await service.login(482273, 'user', 'pass', '127.0.0.1');

      expect(mockPrisma.student.updateMany).toHaveBeenCalledWith({
        where: {
          studentGuid: { in: ['child-gone'] },
          // Scoped by the visibility edge: `inactiveChildren` is school-local,
          // so a login must not retire a child its own school does not list.
          // An unlinked child is included because that means "ownership
          // unknown", not "somebody else's".
          OR: [
            { links: { some: { householdConnectionId: 'conn-new' } } },
            { links: { none: {} } },
          ],
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
      mockSchoolLinksService.listMeSchools.mockResolvedValue([
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'My School',
          shortLabel: 'My School',
          schoolYear: 2026,
        },
      ]);

      const result = await service.getMe('user-1');

      expect(result.username).toBe('test');
      expect(result.schools).toEqual([
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'My School',
          shortLabel: 'My School',
          schoolYear: 2026,
        },
      ]);
    });

    it('returns every connected school, newest sign-in first', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'Test Parent',
      });
      mockSchoolLinksService.listMeSchools.mockResolvedValue([
        { id: 'conn-b', semel: 999999, schoolName: 'B', shortLabel: 'B', schoolYear: 2027 },
        { id: 'conn-a', semel: 540175, schoolName: 'A', shortLabel: 'A', schoolYear: 2026 },
      ]);

      const result = await service.getMe('user-1');

      expect(result.schools.map((school) => school.id)).toEqual(['conn-b', 'conn-a']);
    });

    it('carries no `connectedSchool`, in either shape (T14)', async () => {
      // It was `schools[0]` under a singular name, and a household with two
      // schools has no primary one -- so the honest fix is deletion, not a
      // better query. Asserted as an absent KEY rather than a falsy value:
      // `toBeUndefined()` would also pass against `connectedSchool: null`,
      // which is the field still being there and empty.
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'Test Parent',
      });
      mockSchoolLinksService.listMeSchools.mockResolvedValue([
        { id: 'conn-b', semel: 999999, schoolName: 'B', shortLabel: 'B', schoolYear: 2027 },
        { id: 'conn-a', semel: 540175, schoolName: 'A', shortLabel: 'A', schoolYear: 2026 },
      ]);

      const result = await service.getMe('user-1');

      expect(Object.keys(result).sort()).toEqual([
        'childrenCount',
        'displayName',
        'mashovUserId',
        'schools',
        'username',
      ]);
    });

    it('returns an empty schools list rather than omitting it', async () => {
      // `[]`, not undefined: every badge does `me.schools.length >= 2`, and an
      // absent array would throw in the app shell before anything renders.
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'Test Parent',
      });
      mockSchoolLinksService.listMeSchools.mockResolvedValue([]);

      const result = await service.getMe('user-1');

      expect(result.schools).toEqual([]);
    });

    it('throws 401 when user not found', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      await expect(service.getMe('ghost')).rejects.toThrow(UnauthorizedException);
    });

    it('still answers for a user with no active connection', async () => {
      // The empty household used to be interesting because it was the one
      // state `connectedSchool` was null in. What has to stay true without it
      // is that `getMe` answers at all rather than throwing -- it is the app
      // shell's first read, and a parent between unlinking and re-linking
      // reaches it.
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'u1',
        mashovUserId: 'm1',
        username: 'u',
        displayName: 'U',
      });
      mockSchoolLinksService.listMeSchools.mockResolvedValue([]);

      const result = await service.getMe('u1');

      expect(result).toEqual({
        mashovUserId: 'm1',
        username: 'u',
        displayName: 'U',
        childrenCount: 0,
        schools: [],
      });
    });

    // R8. `credential.displayName` is per-school and comes back as the
    // parent's name plus ONE of that school's children; login writes it to
    // the single global `AppUser.displayName`, so the header named that one
    // child above every school's content. The count is the honest answer to
    // what the tag was implying.
    it('strips the credential child tag and reports the children count', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'קורס דמיטרי [מיקה ז8]',
      });
      mockPrisma.householdConnection.findMany.mockResolvedValue([
        { id: 'conn-a' },
        { id: 'conn-b' },
      ]);
      mockPrisma.student.count.mockResolvedValue(2);

      const result = await service.getMe('user-1');

      expect(result.displayName).toBe('קורס דמיטרי');
      expect(result.childrenCount).toBe(2);
    });

    it('counts children with the predicate /children uses', async () => {
      // Not over `StudentConnection` directly: `visibleStudentWhere` admits a
      // child no connection links yet, and a header saying "2 ילדים" over a
      // page listing 3 is a bug the parent can see.
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mashovUserId: 'mashov-1',
        username: 'test',
        displayName: 'Test Parent',
      });
      mockPrisma.householdConnection.findMany.mockResolvedValue([{ id: 'conn-a' }]);
      mockPrisma.student.count.mockResolvedValue(1);

      await service.getMe('user-1');

      expect(mockPrisma.student.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { links: { some: { householdConnectionId: { in: ['conn-a'] } } } },
            { links: { none: {} } },
          ],
          isActive: true,
        },
      });
    });
  });

});

describe('AuthService login adoption', () => {
  /**
   * Mashov issues a separate account per school, with a different
   * `credential.userId` for each. Without adoption, signing in with the second
   * school's credentials creates a SECOND AppUser, a second session and a
   * second household -- so a parent who linked school B from inside their
   * session, signed out, and signed back in with B's password would land in an
   * empty app with no route back to their own children.
   *
   * Reaching the adoption branch at all proves the caller holds that school's
   * password: Mashov has already validated it. See ADR-0029.
   */
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolLinksService.listMeSchools.mockResolvedValue([]);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.reconcileFromLogin.mockImplementation((candidate: number) => ({
      year: candidate,
      changed: false,
    }));
    mockRedis.incr.mockResolvedValue(1);
    mockHttp.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
    mockPrisma.student.upsert.mockResolvedValue({});
    mockPrisma.student.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.householdConnection.update.mockResolvedValue({ id: 'conn-b' });
    mockPrisma.householdConnection.create.mockResolvedValue({ id: 'conn-new' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
        { provide: SchoolLinksService, useValue: mockSchoolLinksService },
        MashovCredentialValidatorService,
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('attaches the session to the household that already owns the connection', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-b',
      mashovUniqueId: 'uniq',
      userId: 'household-1',
    });
    // Explicit, and it has to be: `jest.clearAllMocks()` clears calls but not
    // implementations, so an unmocked `findUnique` here answers whatever the
    // previously-run test left on the shared mock. This is the
    // production-common adoption shape -- no AppUser yet for the second
    // school's credential -- and it should not depend on test order.
    mockPrisma.appUser.findUnique.mockResolvedValue(null);

    const result = await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'household-1',
      '127.0.0.1',
    );
    expect(result.isFirstLogin).toBe(false);
  });

  it('creates no second AppUser for the adopted school', async () => {
    // The structural fix. `AppUser.mashovUserId` is unique and comes from the
    // per-school credential, so an upsert here would fork the household.
    //
    // Genuinely cross-school: the AppUser for THIS credential is a different
    // household from the one that owns the connection. That is the only shape
    // adoption is for, and the gate has to let it through.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-b',
      mashovUniqueId: 'uniq',
      userId: 'household-1',
    });
    mockPrisma.appUser.findUnique.mockResolvedValue({
      id: 'household-2',
      mashovUserId: 'mashov-uid-1',
      displayName: 'Test Parent',
      mergedIntoUserId: null,
    });

    const result = await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockPrisma.appUser.upsert).not.toHaveBeenCalled();
    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'household-1',
      '127.0.0.1',
    );
    expect(result.isFirstLogin).toBe(false);
  });

  it('refreshes displayName when the connection already belongs to this household', async () => {
    // A returning single-school sign-in is NOT an adoption: the connection
    // belongs to the very AppUser this credential maps to. Taking the adoption
    // branch here returns before the upsert, which is the only place
    // `displayName` is refreshed from the credential -- so a name the school
    // later corrects would never reach the app.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-a',
      mashovUniqueId: 'uniq',
      userId: 'household-1',
    });
    mockPrisma.appUser.findUnique.mockResolvedValue({
      id: 'household-1',
      mashovUserId: 'mashov-uid-1',
      displayName: 'Stale Name',
      mergedIntoUserId: null,
    });
    mockPrisma.appUser.upsert.mockResolvedValue({
      id: 'household-1',
      mergedIntoUserId: null,
    });

    const result = await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockPrisma.appUser.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { username: 'parent-b', displayName: 'Test Parent' },
      }),
    );
    expect(result.isFirstLogin).toBe(false);
  });

  it('still refreshes the connection and its roster on an adopted login', async () => {
    // The password may have changed, and the roster is the only signal that a
    // child joined or left.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-b',
      mashovUniqueId: 'uniq',
      userId: 'household-1',
    });
    mockPrisma.appUser.findUnique.mockResolvedValue(null);
    mockHttp.post = jest.fn().mockResolvedValue({
      data: {
        ...mockLoginResponse,
        accessToken: {
          ...mockLoginResponse.accessToken,
          children: [
            {
              childGuid: 'guid-b1',
              familyName: 'Kors',
              privateName: 'Noa',
              classCode: 'י',
              classNum: 1,
              gender: 'F',
              groups: [1],
            },
          ],
        },
      },
    });

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn-b' } }),
    );
    expect(mockPrisma.student.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ householdConnectionId: 'conn-b' }),
      }),
    );
  });

  it('does not adopt a connection that belongs to nobody', async () => {
    // A first-ever sign-in for an account nobody has linked gets its own
    // household. The app cannot know two Mashov accounts are one parent --
    // merging is always initiated from inside an authenticated session.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-orphan',
      mashovUniqueId: null,
      userId: null,
    });
    mockPrisma.appUser.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.upsert.mockResolvedValue({ id: 'app-user-new', mergedIntoUserId: null });

    const result = await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockPrisma.appUser.upsert).toHaveBeenCalled();
    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'app-user-new',
      '127.0.0.1',
    );
    expect(result.isFirstLogin).toBe(true);
  });

  it('follows a merge pointer exactly one hop', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === 'household-merged'
          ? { id: 'household-merged', mergedIntoUserId: null }
          : null,
      ),
    );
    mockPrisma.appUser.upsert.mockResolvedValue({
      id: 'app-user-orphan',
      mergedIntoUserId: 'household-merged',
    });

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'household-merged',
      '127.0.0.1',
    );
  });

  it('bails to the original on a self-pointer rather than looping', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.upsert.mockResolvedValue({
      id: 'app-user-self',
      mergedIntoUserId: 'app-user-self',
    });

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'app-user-self',
      '127.0.0.1',
    );
  });

  it('bails to the original on a cycle rather than looping', async () => {
    // A -> B -> A. One hop stops here by construction; the warning is the
    // only trace that the data is inconsistent.
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockResolvedValue({
      id: 'household-b',
      mergedIntoUserId: 'app-user-a',
    });
    mockPrisma.appUser.upsert.mockResolvedValue({
      id: 'app-user-a',
      mergedIntoUserId: 'household-b',
    });

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    // One hop lands on B and stops. It does not come back round to A.
    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'household-b',
      '127.0.0.1',
    );
  });

  it('keeps its own household when the merge pointer names a user that is gone', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.upsert.mockResolvedValue({
      id: 'app-user-a',
      mergedIntoUserId: 'household-deleted',
    });

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
      'app-user-a',
      '127.0.0.1',
    );
  });

  it('reproduces the old behaviour exactly when the kill switch is off', async () => {
    const previous = process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
    process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = 'false';
    try {
      mockPrisma.householdConnection.findUnique.mockResolvedValue({
        id: 'conn-b',
        mashovUniqueId: 'uniq',
        userId: 'household-1',
      });
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      mockPrisma.appUser.upsert.mockResolvedValue({
        id: 'app-user-forked',
        mergedIntoUserId: null,
      });

      await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

      // The forking behaviour this feature exists to remove, available in one
      // env var if adoption ever proves to be the wrong call.
      expect(mockPrisma.appUser.upsert).toHaveBeenCalled();
      expect(mockAppSessionService.createSession).toHaveBeenCalledWith(
        'app-user-forked',
        '127.0.0.1',
      );
    } finally {
      if (previous === undefined) delete process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
      else process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = previous;
    }
  });

  it('adopts only after Mashov has accepted the password', async () => {
    // The authorisation. A wrong password must never reach the adoption
    // branch, or holding a username would be enough to enter a household.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-b',
      mashovUniqueId: 'uniq',
      userId: 'household-1',
    });
    mockHttp.post = jest.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 401'), {
        isAxiosError: true,
        response: { status: 401 },
      }),
    );

    await expect(
      service.login(999999, 'parent-b', 'wrong-pw', '127.0.0.1'),
    ).rejects.toThrow(UnauthorizedException);

    expect(mockAppSessionService.createSession).not.toHaveBeenCalled();
    expect(mockPrisma.householdConnection.update).not.toHaveBeenCalled();
  });
});

/**
 * Mashov answers a failed login with a `Reason` header naming the real cause.
 * For these values the password is CORRECT and the account needs a next step,
 * so collapsing them into "wrong password" sends the parent off to retype a
 * password that was right until the rate limiter locks them out.
 *
 * Every signposted answer is a 400, never a 401: `apiFetch` in the frontend
 * hard-redirects to /auth/sign-in on any 401 whose code is not
 * INVALID_CREDENTIALS, which would throw the parent off the page carrying the
 * instructions they need.
 */
describe('AuthService login reason signposting', () => {
  let service: AuthService;

  function reasonFailure(reason: string, data: unknown = {}): AxiosError {
    const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
    err.response = {
      status: 403,
      data,
      headers: { reason },
    } as unknown as AxiosError['response'];
    return err;
  }

  async function errorBodyFor(reason: string, data: unknown = {}) {
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockHttp.post = jest.fn().mockRejectedValue(reasonFailure(reason, data));

    try {
      await service.login(482273, 'user', 'pass', '127.0.0.1');
    } catch (err) {
      const http = err as HttpException;
      return {
        status: http.getStatus(),
        body: http.getResponse() as {
          error: { code: string; details?: unknown[]; challengeId?: string };
        },
      };
    }
    throw new Error(`login resolved for Reason=${reason}; it must reject`);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolLinksService.listMeSchools.mockResolvedValue([]);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.reconcileFromLogin.mockImplementation((candidate: number) => ({
      year: candidate,
      changed: false,
    }));
    mockRedis.incr.mockResolvedValue(1);
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
        { provide: SchoolLinksService, useValue: mockSchoolLinksService },
        MashovCredentialValidatorService,
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('answers 400 PASSWORD_CHANGE_REQUIRED on Reason=ChangePass', async () => {
    const { status, body } = await errorBodyFor('ChangePass');
    expect(status).toBe(400);
    expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('answers 400 CREDENTIALS_SETUP_REQUIRED on Reason=SetUsernameAndPass', async () => {
    const { status, body } = await errorBodyFor('SetUsernameAndPass');
    expect(status).toBe(400);
    expect(body.error.code).toBe('CREDENTIALS_SETUP_REQUIRED');
  });

  it('answers 400 CAPTCHA_REQUIRED on Reason=UserSuspended', async () => {
    const { status, body } = await errorBodyFor('UserSuspended');
    expect(status).toBe(400);
    expect(body.error.code).toBe('CAPTCHA_REQUIRED');
  });

  it('answers 400 NO_CHILDREN on Reason=NoChildren', async () => {
    const { status, body } = await errorBodyFor('NoChildren');
    expect(status).toBe(400);
    expect(body.error.code).toBe('NO_CHILDREN');
  });

  it('carries the MFA challengeId through so the next screen has a handle', async () => {
    const { status, body } = await errorBodyFor('MfaRequired', { challengeId: 'ch-77' });
    expect(status).toBe(400);
    expect(body.error.code).toBe('MFA_REQUIRED');
    // Beside the envelope's three fields rather than inside `details[]`:
    // `details` is for field-level validation errors, and a challenge id
    // smuggled in as `{field,message}` would be read by nobody.
    expect(body.error.challengeId).toBe('ch-77');
  });

  it('still answers MFA_REQUIRED when Mashov sends no challengeId', async () => {
    const { status, body } = await errorBodyFor('MfaRequired');
    expect(status).toBe(400);
    expect(body.error.code).toBe('MFA_REQUIRED');
    expect(body.error.challengeId).toBeUndefined();
    expect(body.error.details).toEqual([]);
  });

  it('keeps INVALID_CREDENTIALS for a Reason with no signpost of its own', async () => {
    const { status, body } = await errorBodyFor('IdNumberNoMatch');
    expect(status).toBe(401);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('keeps INVALID_CREDENTIALS for a Reason value it has never seen', async () => {
    const { status, body } = await errorBodyFor('SomeBrandNewUpstreamReason');
    expect(status).toBe(401);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('still reports an unreachable upstream as 502, not as a signpost', async () => {
    jest.spyOn(axios, 'isCancel').mockReturnValue(true);
    mockHttp.post = jest.fn().mockRejectedValue(new CanceledError('canceled'));

    await expect(service.login(482273, 'user', 'pass', '127.0.0.1')).rejects.toThrow(
      BadGatewayException,
    );
  });
});

/**
 * A password reset through our own recovery flow marks the connection stale.
 * A sign-in is what heals it, because a sign-in is the one moment we hold the
 * plaintext password and rewrite `encryptedPassword` -- so the flag has to be
 * cleared on exactly the same writes, or a parent who has already fixed things
 * keeps being told their school needs attention.
 */
describe('AuthService login clears a stale credential flag', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolLinksService.listMeSchools.mockResolvedValue([]);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.reconcileFromLogin.mockImplementation((candidate: number) => ({
      year: candidate,
      changed: false,
    }));
    mockSchoolYearService.schoolNameFor.mockResolvedValue(null);
    mockRedis.incr.mockResolvedValue(1);
    mockHttp.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
    mockPrisma.student.upsert.mockResolvedValue({});
    mockPrisma.student.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.householdConnection.update.mockResolvedValue({ id: 'conn-1' });
    mockPrisma.householdConnection.create.mockResolvedValue({ id: 'conn-new' });
    mockPrisma.appUser.upsert.mockResolvedValue({ id: 'user-1', mergedIntoUserId: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
        { provide: SchoolLinksService, useValue: mockSchoolLinksService },
        MashovCredentialValidatorService,
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('clears it on the update branch, beside the rewritten password', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      mashovUniqueId: null,
      userId: 'user-1',
    });
    mockPrisma.appUser.findUnique.mockResolvedValue({
      id: 'user-1',
      mergedIntoUserId: null,
    });

    await service.login(482273, 'testuser', 'pw', '127.0.0.1');

    const data = mockPrisma.householdConnection.update.mock.calls[0][0].data;
    expect(data.encryptedPassword).toBe('encrypted-pw');
    expect(data.credentialStaleAt).toBeNull();
  });

  it('clears it on the create branch', async () => {
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.findUnique.mockResolvedValue(null);

    await service.login(482273, 'testuser', 'pw', '127.0.0.1');

    const data = mockPrisma.householdConnection.create.mock.calls[0][0].data;
    expect(data.encryptedPassword).toBe('encrypted-pw');
    expect(data.credentialStaleAt).toBeNull();
  });

  it('clears it on the adoption branch too', async () => {
    // The branch that returns early. Missed here, a parent who reset school B
    // and then signed in with B's password would still be told B is broken.
    mockPrisma.householdConnection.findUnique.mockResolvedValue({
      id: 'conn-b',
      mashovUniqueId: null,
      userId: 'household-1',
    });
    mockPrisma.appUser.findUnique.mockResolvedValue(null);

    await service.login(999999, 'parent-b', 'pw', '127.0.0.1');

    const data = mockPrisma.householdConnection.update.mock.calls[0][0].data;
    expect(data.encryptedPassword).toBe('encrypted-pw');
    expect(data.credentialStaleAt).toBeNull();
  });
});

/**
 * Fixes from the whole-branch review.
 */
describe('AuthService review fixes', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolLinksService.listMeSchools.mockResolvedValue([]);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });
    mockSchoolYearService.reconcileFromLogin.mockImplementation((candidate: number) => ({
      year: candidate,
      changed: false,
    }));
    mockSchoolYearService.schoolNameFor.mockResolvedValue(null);
    mockRedis.incr.mockResolvedValue(1);
    mockHttp.post = jest.fn().mockResolvedValue({ data: mockLoginResponse });
    mockPrisma.student.upsert.mockResolvedValue({});
    mockPrisma.student.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockPrisma.householdConnection.update.mockResolvedValue({ id: 'conn-1' });
    mockPrisma.householdConnection.create.mockResolvedValue({ id: 'conn-new' });
    mockPrisma.appUser.findUnique.mockResolvedValue(null);
    mockPrisma.appUser.upsert.mockResolvedValue({ id: 'user-1', mergedIntoUserId: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AppSessionService, useValue: mockAppSessionService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
        { provide: SchoolLinksService, useValue: mockSchoolLinksService },
        MashovCredentialValidatorService,
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  function persist(overrides: Record<string, unknown> = {}) {
    return service.persistSessionFromLogin({
      semel: 482273,
      username: 'testuser',
      password: 'pw',
      year: 2027,
      loginData: mockLoginResponse,
      ip: '127.0.0.1',
      existingConnBeforeLogin: { id: 'conn-1', mashovUniqueId: null, userId: 'user-1' },
      credentialProven: true,
      ...overrides,
    });
  }

  describe('credentialProven gates the stale-flag clearing', () => {
    it('clears the flag when the password was proven upstream', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mergedIntoUserId: null,
      });
      await persist({ credentialProven: true });

      const data = mockPrisma.householdConnection.update.mock.calls[0][0].data;
      expect(data.credentialStaleAt).toBeNull();
    });

    it('leaves the flag ALONE when the password was not proven', async () => {
      // An OTP sign-in re-stores the password it already had -- which may be
      // the dead one a reset just invalidated. Clearing the flag there throws
      // away the only signal saying which school needs attention, and sync
      // stays broken with nothing to show for it.
      mockPrisma.appUser.findUnique.mockResolvedValue({
        id: 'user-1',
        mergedIntoUserId: null,
      });
      await persist({ credentialProven: false });

      const data = mockPrisma.householdConnection.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('credentialStaleAt');
    });

    it('leaves it alone on the create branch too', async () => {
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
      await persist({ credentialProven: false, existingConnBeforeLogin: null });

      const data = mockPrisma.householdConnection.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('credentialStaleAt');
    });

    it('leaves it alone on the adoption branch too', async () => {
      mockPrisma.appUser.findUnique.mockResolvedValue(null);
      await persist({
        credentialProven: false,
        existingConnBeforeLogin: {
          id: 'conn-b',
          mashovUniqueId: null,
          userId: 'household-1',
        },
      });

      const data = mockPrisma.householdConnection.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('credentialStaleAt');
    });
  });

  describe('an ordinary sign-in seeds the trusted-device credential', () => {
    it('persists the devicePass the login response carried', async () => {
      // Mashov issues one on `POST /api/login` too, not only on mfa/verify.
      // Dropped, the trusted-device path is never seeded by the one sign-in
      // every parent actually performs.
      mockHttp.post = jest.fn().mockResolvedValue({
        data: mockLoginResponse,
        headers: { devicepass: 'dp-from-login' },
      });
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      await service.login(482273, 'testuser', 'pw', '127.0.0.1');

      const data = mockPrisma.householdConnection.create.mock.calls[0][0].data;
      expect(data.devicePass).toBe('encrypted-pw');
    });

    it('writes no devicePass when the response carried none', async () => {
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      await service.login(482273, 'testuser', 'pw', '127.0.0.1');

      const data = mockPrisma.householdConnection.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('devicePass');
    });

    it('still clears the stale flag, because a login proves the password', async () => {
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      await service.login(482273, 'testuser', 'pw', '127.0.0.1');

      const data = mockPrisma.householdConnection.create.mock.calls[0][0].data;
      expect(data.credentialStaleAt).toBeNull();
    });
  });
});
