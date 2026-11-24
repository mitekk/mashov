import { HttpException, Logger } from '@nestjs/common';
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
const mockEncryption = {
  decrypt: jest.fn().mockReturnValue('stored-pw'),
  hashKey: jest.fn().mockReturnValue(Buffer.from('test-identity-hash-key')),
};
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

/**
 * What a proxy ACL rejection looks like: a 4xx with an HTML body and no
 * `Reason`. Our egress is a residential proxy, so this is not hypothetical, and
 * it must never be reported as anything about the parent's input.
 */
function proxyError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: '<html><body>Access denied</body></html>',
    headers: { 'content-type': 'text/html' },
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
    mockEncryption.hashKey.mockReturnValue(Buffer.from('test-identity-hash-key'));
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

    /**
     * The hole this flow shipped through.
     *
     * `classify` took a `stage` argument and used it only in a log message, so
     * an unmapped Mashov 4xx on the SEND-ME-A-CODE call answered
     * `INVALID_OTP_CODE` -- "that code is not valid" -- to a parent who had not
     * been given a code, let alone typed one. It reproduced identically on
     * email and sms, and because the code input only renders once this call
     * succeeds, it also looked like a missing form field.
     *
     * Three different upstream answers reach this point, and all three were
     * mis-reported, so all three are asserted here.
     */
    describe('an unmapped refusal is never reported as a bad code', () => {
      it('answers OTP_REQUEST_REFUSED for a Reason-less JSON 4xx', async () => {
        mockUpstream.requestOtp.mockRejectedValue(bareError(400));
        expect(await thrown(() => request())).toEqual({
          status: 400,
          code: 'OTP_REQUEST_REFUSED',
        });
      });

      it('answers OTP_REQUEST_REFUSED for a recognised but unmapped Reason', async () => {
        // The single most likely live cause: we send a hard-coded CSRF literal
        // and no cookie at all. `NotAuthenticated` is in MASHOV_REASONS but is
        // mapped on no branch of this switch, so it fell to the same fallback.
        mockUpstream.requestOtp.mockRejectedValue(reasonError('NotAuthenticated'));
        expect(await thrown(() => request())).toEqual({
          status: 400,
          code: 'OTP_REQUEST_REFUSED',
        });
      });

      it('answers OTP_REQUEST_REFUSED for a Reason we have never seen', async () => {
        // `readReason` drops anything outside MASHOV_REASONS, so an unknown
        // value arrived here indistinguishable from no Reason at all.
        mockUpstream.requestOtp.mockRejectedValue(reasonError('SomeNewReason'));
        expect(await thrown(() => request())).toEqual({
          status: 400,
          code: 'OTP_REQUEST_REFUSED',
        });
      });

      // The three code-validity Reasons are as meaningless here as the bare
      // 4xx was: there is no code at this stage for Mashov to have an opinion
      // about.
      for (const reason of ['MfaInvalidCode', 'MfaCodeExpired', 'MfaExpired']) {
        it(`does not pass ${reason} through as a code error`, async () => {
          mockUpstream.requestOtp.mockRejectedValue(reasonError(reason));
          expect(await thrown(() => request())).toEqual({
            status: 400,
            code: 'OTP_REQUEST_REFUSED',
          });
        });
      }

      it('still answers 502 for a proxy ACL page, not a refusal', async () => {
        // The `isMashovRejection` gate must not have been loosened to reach
        // the new code: only Mashov's own API gets to refuse an account.
        mockUpstream.requestOtp.mockRejectedValue(proxyError(403));
        expect(await thrown(() => request())).toEqual({
          status: 502,
          code: 'UPSTREAM_ERROR',
        });
      });
    });

    it('never answers 401 on any path', async () => {
      // The verify stage has had this assertion since it shipped; step 1 never
      // did, which is part of why the above went unnoticed. `apiFetch`
      // hard-redirects on any 401 whose code is not INVALID_CREDENTIALS, which
      // would throw the parent off the page mid-sign-in.
      for (const arrange of [
        () => mockUpstream.requestOtp.mockRejectedValue(bareError(401)),
        () => mockUpstream.requestOtp.mockRejectedValue(reasonError('NotAuthenticated', 401)),
        () => mockPrisma.householdConnection.findUnique.mockResolvedValue(null),
      ]) {
        jest.clearAllMocks();
        jest.spyOn(axios, 'isCancel').mockReturnValue(false);
        jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
        mockPrisma.householdConnection.findUnique.mockResolvedValue(CONNECTION);
        arrange();
        expect((await thrown(() => request())).status).not.toBe(401);
      }
    });

    describe('the log line that makes one production repro enough', () => {
      it('records the status and the raw Reason, including one we do not know', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        mockUpstream.requestOtp.mockRejectedValue(reasonError('SomeNewReason'));
        await thrown(() => request());

        const line = warn.mock.calls.map(([first]) => String(first)).join('\n');
        expect(line).toContain('stage=request');
        expect(line).toContain('status=403');
        // The whole point: `readReason` would have discarded this value, and
        // an unrecognised Reason is exactly the evidence worth having.
        expect(line).toContain('reason=SomeNewReason');
        expect(line).toContain('path=/api/user/otp/request');
      });

      it('logs no identity and no secret', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        mockUpstream.requestOtp.mockRejectedValue(bareError(400));
        await thrown(() => request());

        const line = warn.mock.calls.map(([first]) => String(first)).join('\n');
        // USERNAME is a realistic national ID number, which is what it is for
        // these accounts -- the thing ADR-0042 §9's HMAC'd keys exist to keep
        // out of plaintext. `semel` is a public school code and is fine.
        expect(line).not.toContain(USERNAME);
        expect(line).toContain(`semel=${SEMEL}`);
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

describe('OtpService review fixes', () => {
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
    mockEncryption.hashKey.mockReturnValue(Buffer.from('test-identity-hash-key'));
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

  it('does NOT claim the password was proven', async () => {
    // It re-stores the password it already had -- which may be the dead one a
    // reset just invalidated. Clearing the stale flag here would throw away
    // the only signal saying which school needs attention.
    await service.createSession(OTP_ID, { code: '123456' }, IP);

    expect(mockAuth.persistSessionFromLogin).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProven: false }),
    );
  });

  it('limits code requests per identity as well as per IP', async () => {
    // Per-IP alone does nothing against a botnet, and the 409 this route can
    // answer tells the caller whether that person uses our app at all.
    const keys: string[] = [];
    mockRedis.incr.mockImplementation((key: string) => {
      keys.push(key);
      return Promise.resolve(1);
    });

    await service.request({ semel: SEMEL, username: USERNAME, method: 'email' }, IP);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(`ratelimit:otp:${IP}`);
    expect(keys[1]).toMatch(new RegExp(`^ratelimit:otp:id:${SEMEL}:[0-9a-f]{64}$`));
  });

  it('parks no raw username in a rate-limit key', async () => {
    const keys: string[] = [];
    mockRedis.incr.mockImplementation((key: string) => {
      keys.push(key);
      return Promise.resolve(1);
    });

    await service.request({ semel: SEMEL, username: USERNAME, method: 'email' }, IP);

    expect(keys.join(' ')).not.toContain(USERNAME);
  });

  it('refuses the membership probe once the per-identity budget is gone', async () => {
    mockRedis.incr.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':id:') ? 99 : 1),
    );

    expect(
      await thrown(() =>
        service.request({ semel: SEMEL, username: USERNAME, method: 'email' }, IP),
      ),
    ).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(mockPrisma.householdConnection.findUnique).not.toHaveBeenCalled();
  });
});
