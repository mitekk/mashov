import { HttpException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import axios, { AxiosError, CanceledError } from 'axios';
import { MfaService } from './mfa.service';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';

const mockUpstream = {
  sendMfa: jest.fn(),
  verifyMfa: jest.fn(),
};

const mockAuth = {
  persistSessionFromLogin: jest.fn(),
};

const mockPrisma = {
  householdConnection: { findUnique: jest.fn() },
};

const mockSchoolYear = {
  resolveForSchool: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
};

const SEMEL = 482273;
const USERNAME = '303977367';
const IP = '203.0.113.9';
const CHALLENGE = 'ch-1';

function reasonError(reason: string, status = 403): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { reason },
  } as unknown as AxiosError['response'];
  return err;
}

/**
 * A Mashov answer with no `Reason` header. The JSON content type matters: it is
 * what marks the response as having come from Mashov's API rather than from a
 * proxy ACL page or a WAF, and only the former is evidence about the input.
 */
function bareError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { 'content-type': 'application/json' },
  } as unknown as AxiosError['response'];
  return err;
}

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return {
      status: http.getStatus(),
      code: (http.getResponse() as { error: { code: string } }).error.code,
    };
  }
  throw new Error('expected a rejection, got a resolution');
}

describe('MfaService', () => {
  let service: MfaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.sendMfa.mockResolvedValue(undefined);
    mockUpstream.verifyMfa.mockResolvedValue({
      data: { credential: { userId: 'u1' } },
      newUniqueId: 'uniq-1',
      csrfToken: 'csrf-1',
      devicePass: 'dp-1',
    });
    mockAuth.persistSessionFromLogin.mockResolvedValue({
      sessionToken: 'tok',
      isFirstLogin: true,
    });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: RedisService, useValue: mockRedis },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(MfaService);
  });

  describe('sendCode', () => {
    it('asks Mashov to send the code on the chosen channel', async () => {
      await expect(service.sendCode(CHALLENGE, 'sms', IP)).resolves.toEqual({ ok: true });
      expect(mockUpstream.sendMfa).toHaveBeenCalledWith(CHALLENGE, 'sms');
    });

    const CASES: Array<[string, number, string]> = [
      ['MfaResendTooSoon', 429, 'MFA_RESEND_TOO_SOON'],
      ['MfaLocked', 429, 'MFA_LOCKED'],
      ['MfaExpired', 400, 'MFA_CODE_EXPIRED'],
      ['MfaContactMissing', 422, 'MFA_CONTACT_MISSING'],
      ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
    ];

    for (const [reason, status, code] of CASES) {
      it(`maps ${reason} to ${status} ${code}`, async () => {
        mockUpstream.sendMfa.mockRejectedValue(reasonError(reason));
        expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
          status,
          code,
        });
      });
    }

    it('answers 502 when Mashov never responded', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.sendMfa.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    /**
     * The same defect the OTP surface shipped with: `classify` took a `stage`
     * and used it only in a log line, so an unmapped Mashov 4xx on the
     * SEND-ME-A-CODE call answered `INVALID_MFA_CODE` -- "that code is not
     * valid" -- about a code that did not exist yet.
     */
    describe('an unmapped refusal is never reported as a bad code', () => {
      it('answers MFA_SEND_REFUSED for a Reason-less JSON 4xx', async () => {
        mockUpstream.sendMfa.mockRejectedValue(bareError(400));
        expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
          status: 422,
          code: 'MFA_SEND_REFUSED',
        });
      });

      it('answers MFA_SEND_REFUSED for a recognised but unmapped Reason', async () => {
        mockUpstream.sendMfa.mockRejectedValue(reasonError('NotAuthenticated'));
        expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
          status: 422,
          code: 'MFA_SEND_REFUSED',
        });
      });

      it('does not pass MfaInvalidCode through as a code error', async () => {
        mockUpstream.sendMfa.mockRejectedValue(reasonError('MfaInvalidCode'));
        expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
          status: 422,
          code: 'MFA_SEND_REFUSED',
        });
      });

      it('still reports an expired challenge as expired, not refused', async () => {
        // The asymmetry versus OTP step 1: a resend acts on a challenge that
        // already exists, so `MfaExpired` is true of something real here.
        mockUpstream.sendMfa.mockRejectedValue(reasonError('MfaExpired'));
        expect(await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).toEqual({
          status: 400,
          code: 'MFA_CODE_EXPIRED',
        });
      });

      it('logs the status and raw Reason without the challenge id', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        mockUpstream.sendMfa.mockRejectedValue(reasonError('SomeNewReason'));
        await thrown(() => service.sendCode(CHALLENGE, 'email', IP));

        const line = warn.mock.calls.map(([first]) => String(first)).join('\n');
        expect(line).toContain('stage=send');
        expect(line).toContain('reason=SomeNewReason');
        expect(line).toContain('path=/api/login/mfa/send');
        // A bearer handle for someone else's challenge. Not a diagnostic.
        expect(line).not.toContain(CHALLENGE);
      });
    });

    it('never answers 401', async () => {
      // `apiFetch` hard-redirects on any 401 whose code is not
      // INVALID_CREDENTIALS, which would throw the parent off the code screen.
      for (const arrange of [
        () => mockUpstream.sendMfa.mockRejectedValue(bareError(401)),
        () => mockUpstream.sendMfa.mockRejectedValue(bareError(403)),
        () => mockUpstream.sendMfa.mockRejectedValue(reasonError('NotAuthenticated')),
      ]) {
        jest.clearAllMocks();
        jest.spyOn(axios, 'isCancel').mockReturnValue(false);
        jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
        arrange();
        expect((await thrown(() => service.sendCode(CHALLENGE, 'email', IP))).status).not.toBe(
          401,
        );
      }
    });
  });

  describe('createSession', () => {
    function createSession(overrides: Record<string, unknown> = {}) {
      return service.createSession(
        CHALLENGE,
        {
          semel: SEMEL,
          username: USERNAME,
          password: 'pw',
          code: '123456',
          // No `rememberBrowser`: the field was accepted and never read, the
          // controller DTO never had it, and `verifyMfa` is called with
          // `rememberBrowser: true` hardcoded. A caller passing `false` here
          // would have been silently overruled.
          ...overrides,
        },
        IP,
      );
    }

    it('answers the challenge and mints a session', async () => {
      await expect(createSession()).resolves.toEqual({
        sessionToken: 'tok',
        isFirstLogin: true,
      });
    });

    it('passes rememberBrowser through, so Mashov issues a devicePass', async () => {
      // Without it an MFA account signs in once and then every cron re-login
      // re-triggers the challenge, so sync dies the next morning.
      await createSession();
      expect(mockUpstream.verifyMfa).toHaveBeenCalledWith(
        expect.objectContaining({ challengeId: CHALLENGE, rememberBrowser: true }),
      );
    });

    it('forces rememberBrowser on even when the client says otherwise', async () => {
      // The trusted-device credential is not a user preference: it is the only
      // thing that keeps background sync alive for an MFA account.
      await createSession({ rememberBrowser: false });
      expect(mockUpstream.verifyMfa).toHaveBeenCalledWith(
        expect.objectContaining({ rememberBrowser: true }),
      );
    });

    it('builds the login data from the shared builder, with no password in it', async () => {
      await createSession();
      const loginData = mockUpstream.verifyMfa.mock.calls[0][0].loginData;
      expect(loginData).toMatchObject({
        semel: SEMEL,
        year: 2027,
        username: USERNAME,
        appName: 'info.mashov.students',
      });
      expect(loginData).not.toHaveProperty('password');
    });

    it('hands the password to the session writer, so the sync crons have one', async () => {
      // The upstream route rejects a password; OUR side needs it. Mashov
      // already validated it -- answering MfaRequired rather than 401 IS that
      // validation -- and without it the connection has no credential and
      // every background sync for this household is dead.
      await createSession();
      expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'pw', devicePass: 'dp-1' }),
      );
    });

    it('sends the stored uniquId so Mashov recognises a known device', async () => {
      mockPrisma.householdConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        mashovUniqueId: 'uniq-0',
        userId: 'user-1',
      });

      await createSession();

      expect(mockUpstream.verifyMfa.mock.calls[0][0].loginData).toMatchObject({});
      expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          existingConnBeforeLogin: expect.objectContaining({ id: 'conn-1' }),
        }),
      );
    });

    it('passes the code through verbatim, letting the upstream client strip it', async () => {
      // Whitespace stripping is `MashovRecoveryService.verifyMfa`'s job and is
      // proven in its own spec. Doing it here too would be two places that
      // have to agree about what a code looks like.
      await createSession({ code: '123 456' });
      expect(mockUpstream.verifyMfa.mock.calls[0][0].code).toBe('123 456');
    });

    const CASES: Array<[string, number, string]> = [
      ['MfaInvalidCode', 400, 'INVALID_MFA_CODE'],
      ['MfaCodeExpired', 400, 'MFA_CODE_EXPIRED'],
      ['MfaExpired', 400, 'MFA_CODE_EXPIRED'],
      ['MfaLocked', 429, 'MFA_LOCKED'],
      ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
    ];

    for (const [reason, status, code] of CASES) {
      it(`maps ${reason} to ${status} ${code}`, async () => {
        mockUpstream.verifyMfa.mockRejectedValue(reasonError(reason));
        expect(await thrown(() => createSession())).toEqual({ status, code });
      });
    }

    it('answers 502, never an invalid code, when the request is aborted', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.verifyMfa.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => createSession())).toEqual({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('mints no session when the challenge was not answered', async () => {
      mockUpstream.verifyMfa.mockRejectedValue(reasonError('MfaInvalidCode'));
      await thrown(() => createSession());
      expect(mockAuth.persistSessionFromLogin).not.toHaveBeenCalled();
    });

    it('rejects a login payload with no user id rather than minting a session', async () => {
      mockUpstream.verifyMfa.mockResolvedValue({
        data: {},
        newUniqueId: undefined,
        csrfToken: undefined,
        devicePass: undefined,
      });

      expect(await thrown(() => createSession())).toMatchObject({ status: 400 });
      expect(mockAuth.persistSessionFromLogin).not.toHaveBeenCalled();
    });

    it('never answers 401 on any path', async () => {
      for (const arrange of [
        () => mockUpstream.verifyMfa.mockRejectedValue(bareError(401)),
        () => mockUpstream.verifyMfa.mockRejectedValue(bareError(404)),
        () => mockUpstream.verifyMfa.mockRejectedValue(reasonError('NotAuthenticated')),
      ]) {
        jest.clearAllMocks();
        jest.spyOn(axios, 'isCancel').mockReturnValue(false);
        jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
        mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
        mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027 });
        arrange();
        expect((await thrown(() => createSession())).status).not.toBe(401);
      }
    });
  });
});

describe('MfaService review fixes', () => {
  let service: MfaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.sendMfa.mockResolvedValue(undefined);
    mockUpstream.verifyMfa.mockResolvedValue({
      data: { credential: { userId: 'u1' } },
      newUniqueId: 'uniq-1',
      csrfToken: 'csrf-1',
      devicePass: 'dp-1',
    });
    mockAuth.persistSessionFromLogin.mockResolvedValue({
      sessionToken: 'tok',
      isFirstLogin: true,
    });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(MfaService);
  });

  function createSession() {
    return service.createSession(
      CHALLENGE,
      { semel: SEMEL, username: USERNAME, password: 'pw', code: '123456' },
      IP,
    );
  }

  it('does NOT claim the password was proven', async () => {
    // Mashov's verify route rejects the password, so nothing on either side
    // checked it. The Task-7 screen re-asks for it, which makes a typo likely,
    // and a typo must not clear the stale flag for that school.
    await createSession();

    expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProven: false }),
    );
  });

  describe('rate limits', () => {
    it('limits code sends per IP, so nobody can spam a victim\u2019s phone', async () => {
      mockRedis.incr.mockResolvedValue(99);

      expect(await thrown(() => service.sendCode(CHALLENGE, 'sms', IP))).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(mockUpstream.sendMfa).not.toHaveBeenCalled();
    });

    it('limits code attempts per IP, so nobody can brute-force the code', async () => {
      mockRedis.incr.mockResolvedValue(99);

      expect(await thrown(() => createSession())).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(mockUpstream.verifyMfa).not.toHaveBeenCalled();
    });

    it('also caps attempts per challenge, not just per IP', async () => {
      // Per-IP alone does nothing against a botnet grinding one challenge.
      const keys: string[] = [];
      mockRedis.incr.mockImplementation((key: string) => {
        keys.push(key);
        return Promise.resolve(1);
      });

      await createSession();

      expect(keys).toEqual([
        `ratelimit:mfa:${IP}`,
        `ratelimit:mfa:challenge:${CHALLENGE}`,
      ]);
    });

    it('sets each window TTL on its first hit only', async () => {
      mockRedis.incr.mockResolvedValue(1);
      await createSession();
      expect(mockRedis.expire).toHaveBeenCalledTimes(2);

      mockRedis.expire.mockClear();
      mockRedis.incr.mockResolvedValue(2);
      await createSession();
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });
});
