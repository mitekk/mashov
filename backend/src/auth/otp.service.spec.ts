import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import axios, { AxiosError, CanceledError } from 'axios';
import { OtpService } from './otp.service';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';

const mockUpstream = { requestOtp: jest.fn(), verifyOtp: jest.fn() };
const mockAuth = { persistSessionFromLogin: jest.fn() };
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() };
const mockPrisma = { householdConnection: { findUnique: jest.fn() } };
const mockEncryption = { decrypt: jest.fn().mockReturnValue('stored-pw') };
const mockSchoolYear = { resolveForSchool: jest.fn() };

const SEMEL = 482273;
const USERNAME = '303977367';
const IP = '203.0.113.12';
const OTP_ID = '33333333-3333-4333-8333-333333333333';

const CONNECTION = {
  id: 'conn-1',
  mashovUniqueId: 'uniq-0',
  userId: 'user-1',
  encryptedPassword: 'enc-stored-pw',
};

function reasonError(reason: string, status = 403): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { reason },
  } as unknown as AxiosError['response'];
  return err;
}

function bareError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = { status, data: {}, headers: {} } as unknown as AxiosError['response'];
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

/**
 * Passwordless sign-in by one-time code, mirroring Mashov's own `loginMethod`
 * switch.
 *
 * It CANNOT replace password sign-in, and that constraint is enforced rather
 * than hidden: our sixteen cron tasks re-login by decrypting a stored
 * credential, so a household with no stored password would get a working
 * session and no background data at all. The first sign-in for a school must
 * therefore use a password, and this service says so in its own error code.
 */
describe('OtpService', () => {
  let service: OtpService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.requestOtp.mockResolvedValue(undefined);
    mockUpstream.verifyOtp.mockResolvedValue({
      data: { credential: { userId: 'u1' } },
      newUniqueId: 'uniq-1',
      csrfToken: 'csrf-1',
      devicePass: 'dp-1',
    });
    mockAuth.persistSessionFromLogin.mockResolvedValue({
      sessionToken: 'tok',
      isFirstLogin: false,
    });
    mockPrisma.householdConnection.findUnique.mockResolvedValue(CONNECTION);
    mockEncryption.decrypt.mockReturnValue('stored-pw');
    mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027, source: 'calendar' });
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ semel: SEMEL, username: USERNAME, method: 'email', attempts: 0 }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: AuthService, useValue: mockAuth },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: SchoolYearService, useValue: mockSchoolYear },
        { provide: MashovRecoveryService, useValue: mockUpstream },
      ],
    }).compile();

    service = module.get(OtpService);
  });

  function storedState() {
    const call = mockRedis.set.mock.calls[mockRedis.set.mock.calls.length - 1];
    return { key: call[0] as string, value: JSON.parse(call[1] as string), ttl: call[2] };
  }

  describe('request', () => {
    function request(overrides: Record<string, unknown> = {}) {
      return service.request(
        { semel: SEMEL, username: USERNAME, method: 'email', ...overrides },
        IP,
      );
    }

    it('refuses before sending a code when the school has never been signed into', async () => {
      // Stated, not hidden: an OTP-only household would have no stored
      // credential, so every background sync would be dead.
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

      expect(await thrown(() => request())).toMatchObject({
        status: 409,
        code: 'PASSWORD_SIGN_IN_REQUIRED',
      });
      expect(mockUpstream.requestOtp).not.toHaveBeenCalled();
    });

    it('asks Mashov for a code and returns an opaque handle', async () => {
      const result = await request();
      expect(result.otpRequestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.method).toBe('email');
      expect(mockUpstream.requestOtp).toHaveBeenCalledWith({
        semel: SEMEL,
        username: USERNAME,
        method: 'email',
      });
    });

    it('keeps the school and username server-side, so step 2 carries neither', async () => {
      await request();
      expect(storedState().key).toMatch(/^otp:/);
      expect(storedState().value).toMatchObject({
        semel: SEMEL,
        username: USERNAME,
        attempts: 0,
      });
      expect(storedState().ttl).toBe(900);
    });

    it('rate limits per IP', async () => {
      mockRedis.incr.mockResolvedValue(99);
      expect(await thrown(() => request())).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(mockUpstream.requestOtp).not.toHaveBeenCalled();
    });

    const CASES: Array<[string, number, string]> = [
      ['MfaResendTooSoon', 429, 'OTP_RESEND_TOO_SOON'],
      ['MfaLocked', 429, 'OTP_LOCKED'],
      ['MfaContactMissing', 422, 'OTP_CONTACT_MISSING'],
      ['LoginMethodBlocked', 422, 'LOGIN_METHOD_BLOCKED'],
      ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
    ];

    for (const [reason, status, code] of CASES) {
      it(`maps ${reason} to ${status} ${code}`, async () => {
        mockUpstream.requestOtp.mockRejectedValue(reasonError(reason));
        expect(await thrown(() => request())).toEqual({ status, code });
      });
    }

    it('answers 502 when Mashov never responded', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.requestOtp.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => request())).toEqual({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });
  });

  describe('createSession', () => {
    function createSession(code = '123456') {
      return service.createSession(OTP_ID, { code }, IP);
    }

    it('exchanges the code for a session', async () => {
      await expect(createSession()).resolves.toEqual({
        sessionToken: 'tok',
        isFirstLogin: false,
      });
    });

    it('re-stores the connection’s existing password, so sync keeps working', async () => {
      // There is no password in this flow, and `encryptedPassword` is what the
      // crons read. Re-writing the one already stored keeps the column
      // populated without inventing a credential.
      await createSession();
      expect(mockEncryption.decrypt).toHaveBeenCalledWith('enc-stored-pw');
      expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'stored-pw' }),
      );
    });

    it('sends no password upstream', async () => {
      await createSession();
      expect(JSON.stringify(mockUpstream.verifyOtp.mock.calls[0][0])).not.toContain(
        'stored-pw',
      );
    });

    it('consumes the handle on success', async () => {
      await createSession();
      expect(mockRedis.del).toHaveBeenCalledWith(`otp:${OTP_ID}`);
    });

    it('tells the parent to start again when the handle is gone', async () => {
      mockRedis.get.mockResolvedValue(null);
      expect(await thrown(() => createSession())).toMatchObject({
        status: 400,
        code: 'OTP_SESSION_EXPIRED',
      });
    });

    it('counts attempts and burns the handle on the sixth', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ semel: SEMEL, username: USERNAME, method: 'email', attempts: 5 }),
      );

      expect(await thrown(() => createSession())).toMatchObject({
        status: 429,
        code: 'OTP_LOCKED',
      });
      expect(mockRedis.del).toHaveBeenCalledWith(`otp:${OTP_ID}`);
      expect(mockUpstream.verifyOtp).not.toHaveBeenCalled();
    });

    it('refuses when the connection has disappeared between the two steps', async () => {
      mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
      expect(await thrown(() => createSession())).toMatchObject({
        status: 409,
        code: 'PASSWORD_SIGN_IN_REQUIRED',
      });
    });

    const CASES: Array<[string, number, string]> = [
      ['MfaInvalidCode', 400, 'INVALID_OTP_CODE'],
      ['MfaCodeExpired', 400, 'OTP_CODE_EXPIRED'],
      ['MfaExpired', 400, 'OTP_CODE_EXPIRED'],
      ['MfaLocked', 429, 'OTP_LOCKED'],
      ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
    ];

    for (const [reason, status, code] of CASES) {
      it(`maps ${reason} to ${status} ${code}`, async () => {
        mockUpstream.verifyOtp.mockRejectedValue(reasonError(reason));
        expect(await thrown(() => createSession())).toEqual({ status, code });
      });
    }

    it('never renders an outage as a wrong code', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.verifyOtp.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => createSession())).toEqual({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('keeps the handle usable after an outage', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.verifyOtp.mockRejectedValue(new CanceledError('aborted'));
      await thrown(() => createSession());
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('never answers 401 on any path', async () => {
      for (const arrange of [
        () => mockRedis.get.mockResolvedValue(null),
        () => mockUpstream.verifyOtp.mockRejectedValue(bareError(401)),
        () => mockPrisma.householdConnection.findUnique.mockResolvedValue(null),
      ]) {
        jest.clearAllMocks();
        jest.spyOn(axios, 'isCancel').mockReturnValue(false);
        jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
        mockRedis.get.mockResolvedValue(
          JSON.stringify({
            semel: SEMEL,
            username: USERNAME,
            method: 'email',
            attempts: 0,
          }),
        );
        mockPrisma.householdConnection.findUnique.mockResolvedValue(CONNECTION);
        mockSchoolYear.resolveForSchool.mockResolvedValue({ year: 2027 });
        arrange();
        expect((await thrown(() => createSession())).status).not.toBe(401);
      }
    });
  });
});
