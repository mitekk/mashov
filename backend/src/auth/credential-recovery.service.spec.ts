import { HttpException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import axios, { AxiosError, CanceledError } from 'axios';
import { CredentialRecoveryService } from './credential-recovery.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { EncryptionService } from '../session/encryption.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
};

const mockUpstream = {
  requestRecovery: jest.fn(),
  resetPassword: jest.fn(),
  resetPasswordVerify: jest.fn(),
};

const mockPrisma = {
  credentialRecoveryAudit: { create: jest.fn() },
  householdConnection: { findUnique: jest.fn(), update: jest.fn() },
};

const mockSession = {
  invalidateConnection: jest.fn(),
};

/**
 * A real round-trip, not `jest.fn()` stubs: the recovery state is now
 * encrypted at rest, and a stub that does not actually reverse itself would
 * make every "step 2 still works" test pass for the wrong reason.
 */
const mockEncryption = {
  encrypt: (plaintext: string) => `enc:${Buffer.from(plaintext).toString('base64')}`,
  decrypt: (value: string) => {
    if (!value.startsWith('enc:')) throw new Error('not encrypted by this service');
    return Buffer.from(value.slice(4), 'base64').toString('utf8');
  },
  hashKey: () => Buffer.from('test-identity-hash-key'),
};

const GOOD_PASSWORD = 'secret1';
const ID = '303977367';
const SEMEL = 482273;
const IP = '203.0.113.7';

/** An upstream rejection carrying a `Reason` header, as Mashov sends them. */
function proxyErrorWithHeaders(
  status: number,
  headers: Record<string, string>,
): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers,
  } as unknown as AxiosError['response'];
  return err;
}

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
 * proxy ACL page, and only the former is evidence about what the user typed.
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
      body: http.getResponse(),
    };
  }
  throw new Error('expected a rejection, got a resolution');
}

describe('CredentialRecoveryService', () => {
  let service: CredentialRecoveryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.requestRecovery.mockResolvedValue({});
    mockUpstream.resetPassword.mockResolvedValue({ username: ID });
    mockUpstream.resetPasswordVerify.mockResolvedValue({ username: ID });
    mockPrisma.credentialRecoveryAudit.create.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialRecoveryService,
        { provide: RedisService, useValue: mockRedis },
        { provide: MashovRecoveryService, useValue: mockUpstream },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MashovSessionService, useValue: mockSession },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();

    service = module.get(CredentialRecoveryService);
  });

  /** The state `start` wrote into Redis, decrypted and parsed. */
  function storedState() {
    const call = mockRedis.set.mock.calls[mockRedis.set.mock.calls.length - 1];
    return {
      key: call[0] as string,
      value: JSON.parse(mockEncryption.decrypt(call[1] as string)),
      ttl: call[2],
    };
  }

  function start(overrides: Partial<{ channel: 'email' | 'sms'; idNumber: string }> = {}) {
    return service.start(
      { semel: SEMEL, idNumber: overrides.idNumber ?? ID, channel: overrides.channel ?? 'email' },
      IP,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1 — no enumeration
  // ───────────────────────────────────────────────────────────────────────────

  describe('start — no enumeration', () => {
    it('accepts a known ID and returns an opaque recovery id', async () => {
      const result = await start();
      expect(result.recoveryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.channel).toBe('email');
      expect(result.requiresSecondChannel).toBe(false);
    });

    const INDISTINGUISHABLE = [
      'IdNumberNoMatch',
      'NotContactInSchool',
      'BindNotFound',
      'UserInactive',
      'UserInactiveInYear',
      'MfaContactMissing',
      // Folded in on purpose: Mashov only escalates to a captcha for accounts
      // it RECOGNISES, so surfacing CAPTCHA_REQUIRED here would be a perfect
      // "does this ID exist" oracle.
      'UserSuspended',
    ];

    for (const reason of INDISTINGUISHABLE) {
      it(`answers 202 for ${reason} exactly as it does for a real account`, async () => {
        mockUpstream.requestRecovery.mockRejectedValue(reasonError(reason));
        const result = await start();
        expect(result.channel).toBe('email');
        expect(result.requiresSecondChannel).toBe(false);
        expect(result.recoveryId).toMatch(/^[0-9a-f-]{36}$/);
      });
    }

    it('answers 202 for an unmapped 4xx too', async () => {
      mockUpstream.requestRecovery.mockRejectedValue(bareError(400));
      await expect(start()).resolves.toMatchObject({ requiresSecondChannel: false });
    });

    it('produces byte-identical bodies for a known and an unknown ID', async () => {
      const known = await start();

      mockUpstream.requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      const unknown = await start({ idNumber: '000000000' });

      // Same keys, same order, same types, same lengths. Any difference at all
      // turns this endpoint into an ID-number oracle.
      expect(Object.keys(unknown)).toEqual(Object.keys(known));
      expect(JSON.stringify({ ...unknown, recoveryId: 'x' })).toBe(
        JSON.stringify({ ...known, recoveryId: 'x' }),
      );
      expect(unknown.recoveryId).toHaveLength(known.recoveryId.length);
    });

    it('marks the fabricated state poisoned so step 2 can fail it consistently', async () => {
      mockUpstream.requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      await start();
      expect(storedState().value.poisoned).toBe(true);
    });

    it('never stores a poisoned state that looks different in Redis', async () => {
      await start();
      const real = Object.keys(storedState().value).sort();

      mockUpstream.requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      await start();
      expect(Object.keys(storedState().value).sort()).toEqual(real);
    });

    /**
     * The diagnosis this flow never had.
     *
     * Anti-enumeration is about the RESPONSE: an attacker must not be able to
     * use this route to test whether an ID number belongs to a real parent, so
     * a refusal and a real account both answer 202. That reasoning was applied
     * to our own logs as well, by accident, and there it protected nobody --
     * a parent reporting "no email arrived" left no trace to read.
     *
     * These tests pin the split: the response stays indistinguishable (proved
     * by the byte-identical and Redis-shape tests above, which must keep
     * passing untouched), and the log does not.
     */
    describe('the log that makes a silent refusal diagnosable', () => {
      let warn: jest.SpyInstance;
      let log: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      });

      const lines = (spy: jest.SpyInstance) =>
        spy.mock.calls.map(([first]) => String(first)).join('\n');

      it('records a refusal that the response deliberately hides', async () => {
        mockUpstream.requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
        await start();

        const line = lines(warn);
        expect(line).toContain('status=403');
        expect(line).toContain('reason=IdNumberNoMatch');
        expect(line).toContain('path=/api/user/recover');
        expect(line).toContain('stage=recover:email');
      });

      it('records an unmapped refusal, including a Reason we do not know', async () => {
        mockUpstream.requestRecovery.mockRejectedValue(reasonError('SomeNewReason'));
        await start();
        expect(lines(warn)).toContain('reason=SomeNewReason');
      });

      /**
       * The case the first draft of this fix would have missed entirely.
       *
       * `apis/post-api-user-recover.md` admits the channel flag's type is the
       * one thing it never confirmed, and we send `email: true`. A Mashov that
       * ignores an unknown-typed flag answers 200 having sent nothing: no
       * exception, so every line in the `catch` stays silent and the parent is
       * told to check an inbox nothing went to. Only a success-path log catches
       * it, and `isResettingAndVerifying=absent` is the fingerprint.
       */
      it('records a 200 that sent nothing, which throws no error at all', async () => {
        mockUpstream.requestRecovery.mockResolvedValue({});
        await start();

        const line = lines(log);
        expect(line).toContain('isResettingAndVerifying=absent');
        expect(line).toContain('responseKeys=[]');
        expect(line).toContain('channel=email');
        expect(warn).not.toHaveBeenCalled();
      });

      it('distinguishes a real two-channel success from that', async () => {
        mockUpstream.requestRecovery.mockResolvedValue({ isResettingAndVerifying: true });
        await start();
        expect(lines(log)).toContain('isResettingAndVerifying=true');
      });

      it('logs a proxy ACL with the headers that give it away', async () => {
        // An HTML 403 is already caught by `isMashovRejection`, but a proxy
        // answering 403 with a JSON content type is misread as a Mashov
        // refusal. `server=` and `via=` are what tell them apart.
        mockUpstream.requestRecovery.mockRejectedValue(
          proxyErrorWithHeaders(403, { 'content-type': 'application/json', via: 'tinyproxy' }),
        );
        await start();
        expect(lines(warn)).toContain('via=tinyproxy');
      });

      it('logs an upstream 5xx, which used to throw in silence', async () => {
        mockUpstream.requestRecovery.mockRejectedValue(bareError(503));
        await expect(start()).rejects.toThrow();
        expect(lines(warn)).toContain('status=503');
      });

      it('never logs the ID number, on any path', async () => {
        for (const arrange of [
          () => mockUpstream.requestRecovery.mockResolvedValue({}),
          () => mockUpstream.requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch')),
          () => mockUpstream.requestRecovery.mockRejectedValue(bareError(503)),
        ]) {
          warn.mockClear();
          log.mockClear();
          arrange();
          await start().catch(() => undefined);

          // An Israeli national ID number. ADR-0042 §9 keeps it out of
          // plaintext; a "correlation hash" of it would too, since the key
          // lives in this process and the domain is ~10^9.
          expect(lines(warn) + lines(log)).not.toContain(ID);
        }
      });
    });

    it('reports the server-stored two-channel flag rather than trusting the client', async () => {
      mockUpstream.requestRecovery.mockResolvedValue({ isResettingAndVerifying: true });
      const result = await start();
      expect(result.requiresSecondChannel).toBe(true);
      expect(storedState().value.isResettingAndVerifying).toBe(true);
    });

    it('expires the recovery state after 15 minutes', async () => {
      await start();
      expect(storedState().ttl).toBe(900);
      expect(storedState().key).toMatch(/^recovery:/);
    });

    it('asks the SMS channel with cellphone and the email channel with email', async () => {
      await start({ channel: 'sms' });
      expect(mockUpstream.requestRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({ cellphone: true }),
      );

      await start({ channel: 'email' });
      expect(mockUpstream.requestRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({ email: true }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1 — the two deliberate exceptions, and outages
  // ───────────────────────────────────────────────────────────────────────────

  describe('start — throttling and outages', () => {
    for (const reason of [
      'EmailLimitExceeded',
      'EmailLocked',
      'CellphoneLocked',
      'MfaResendTooSoon',
    ]) {
      it(`surfaces ${reason} as 429 RECOVERY_THROTTLED rather than hiding it`, async () => {
        // A deliberate, documented leak: hiding this leaves a locked-out
        // parent retrying forever, which is worse than the information it
        // gives up.
        mockUpstream.requestRecovery.mockRejectedValue(reasonError(reason, 429));
        expect(await thrown(() => start())).toMatchObject({
          status: 429,
          code: 'RECOVERY_THROTTLED',
        });
      });
    }

    it('surfaces a bare upstream 429 as RECOVERY_THROTTLED', async () => {
      mockUpstream.requestRecovery.mockRejectedValue(bareError(429));
      expect(await thrown(() => start())).toMatchObject({
        status: 429,
        code: 'RECOVERY_THROTTLED',
      });
    });

    it('answers 502 when Mashov never responded', async () => {
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockUpstream.requestRecovery.mockRejectedValue(new CanceledError('aborted'));
      expect(await thrown(() => start())).toMatchObject({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('answers 502 on an upstream 5xx rather than fabricating a recovery', async () => {
      mockUpstream.requestRecovery.mockRejectedValue(bareError(503));
      expect(await thrown(() => start())).toMatchObject({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1 — rate limits
  // ───────────────────────────────────────────────────────────────────────────

  describe('start — rate limits', () => {
    it('allows three attempts per IP and refuses the fourth', async () => {
      mockRedis.incr.mockResolvedValue(4);
      expect(await thrown(() => start())).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
    });

    it('limits per (school, ID) as well as per IP', async () => {
      // Per-IP alone does nothing against a botnet enumerating one victim.
      const keys: string[] = [];
      mockRedis.incr.mockImplementation((key: string) => {
        keys.push(key);
        return Promise.resolve(1);
      });

      await start();

      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(`ratelimit:recovery:${IP}`);
      expect(keys[1]).toMatch(new RegExp(`^ratelimit:recovery:id:${SEMEL}:[0-9a-f]{64}$`));
    });

    it('hashes the ID number into the rate-limit key', async () => {
      // A raw ID number would park a national identifier under a greppable
      // Redis key, readable by anything with Redis access.
      const keys: string[] = [];
      mockRedis.incr.mockImplementation((key: string) => {
        keys.push(key);
        return Promise.resolve(1);
      });

      await start();

      expect(keys.join(' ')).not.toContain(ID);
    });

    it('sets the window TTL only on the first hit in each window', async () => {
      mockRedis.incr.mockResolvedValue(1);
      await start();
      expect(mockRedis.expire).toHaveBeenCalledWith(
        `ratelimit:recovery:${IP}`,
        900,
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        expect.stringContaining(`ratelimit:recovery:id:${SEMEL}:`),
        3600,
      );

      mockRedis.expire.mockClear();
      mockRedis.incr.mockResolvedValue(2);
      await start();
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('refuses before touching the upstream at all', async () => {
      mockRedis.incr.mockResolvedValue(9);
      await thrown(() => start());
      expect(mockUpstream.requestRecovery).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 2
  // ───────────────────────────────────────────────────────────────────────────

  describe('completePassword', () => {
    const RID = '11111111-1111-4111-8111-111111111111';

    function stateIs(overrides: Record<string, unknown> = {}) {
      mockRedis.get.mockResolvedValue(
        mockEncryption.encrypt(
          JSON.stringify({
            semel: SEMEL,
            idNumber: ID,
            channel: 'email',
            isResettingAndVerifying: false,
            attempts: 0,
            poisoned: false,
            ...overrides,
          }),
        ),
      );
    }

    function complete(body: Partial<{ code: string; secondCode: string; newPassword: string }> = {}) {
      return service.completePassword(
        RID,
        {
          code: body.code ?? 'ABC123',
          secondCode: body.secondCode,
          newPassword: body.newPassword ?? GOOD_PASSWORD,
        },
        IP,
      );
    }

    beforeEach(() => stateIs());

    it('resets the password and reports the username back', async () => {
      await expect(complete()).resolves.toEqual({ ok: true, username: ID });
      expect(mockUpstream.resetPassword).toHaveBeenCalledWith('ABC123', GOOD_PASSWORD);
    });

    it('consumes the recovery state on success, so a replay cannot reuse it', async () => {
      await complete();
      expect(mockRedis.del).toHaveBeenCalledWith(`recovery:${RID}`);
    });

    it('writes an audit row carrying a hash, never the ID number itself', async () => {
      await complete();
      const row = mockPrisma.credentialRecoveryAudit.create.mock.calls[0][0].data;
      expect(row.schoolCode).toBe(SEMEL);
      expect(row.idNumberHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ip).toBe(IP);
      expect(JSON.stringify(row)).not.toContain(ID);
      expect(JSON.stringify(row)).not.toContain(GOOD_PASSWORD);
      expect(JSON.stringify(row)).not.toContain('ABC123');
    });

    it('rejects a weak password before any upstream call', async () => {
      // Mashov answers 404 for a policy violation AND for a bad code. Checking
      // first is what makes a 404 unambiguously "wrong code" -- and it saves
      // the parent's single-use code.
      expect(await thrown(() => complete({ newPassword: 'abc' }))).toMatchObject({
        status: 422,
        code: 'WEAK_PASSWORD',
      });
      expect(mockUpstream.resetPassword).not.toHaveBeenCalled();
    });

    it('enforces the no-username rule against the recovering ID number', async () => {
      expect(
        await thrown(() => complete({ newPassword: `a1${ID}` })),
      ).toMatchObject({ status: 422, code: 'WEAK_PASSWORD' });
    });

    it('tells the parent to start again when the recovery state is gone', async () => {
      mockRedis.get.mockResolvedValue(null);
      expect(await thrown(() => complete())).toMatchObject({
        status: 400,
        code: 'RECOVERY_SESSION_EXPIRED',
      });
    });

    it('counts attempts and rejects the sixth', async () => {
      stateIs({ attempts: 5 });
      expect(await thrown(() => complete())).toMatchObject({
        status: 429,
        code: 'RECOVERY_LOCKED',
      });
      expect(mockRedis.del).toHaveBeenCalledWith(`recovery:${RID}`);
      expect(mockUpstream.resetPassword).not.toHaveBeenCalled();
    });

    it('persists the incremented attempt count before calling upstream', async () => {
      mockUpstream.resetPassword.mockRejectedValue(bareError(404));
      await thrown(() => complete());
      expect(storedState().value.attempts).toBe(1);
    });

    describe('two-channel', () => {
      it('uses the verify route with both codes', async () => {
        stateIs({ isResettingAndVerifying: true });
        await complete({ secondCode: 'DEF456' });
        expect(mockUpstream.resetPasswordVerify).toHaveBeenCalledWith(
          'ABC123',
          'DEF456',
          GOOD_PASSWORD,
        );
        expect(mockUpstream.resetPassword).not.toHaveBeenCalled();
      });

      it('demands the second code when the SERVER-stored flag says so', async () => {
        stateIs({ isResettingAndVerifying: true });
        expect(await thrown(() => complete())).toMatchObject({
          status: 400,
          code: 'SECOND_CODE_REQUIRED',
        });
      });

      it('ignores a second code the server did not ask for', async () => {
        stateIs({ isResettingAndVerifying: false });
        await complete({ secondCode: 'DEF456' });
        expect(mockUpstream.resetPassword).toHaveBeenCalled();
        expect(mockUpstream.resetPasswordVerify).not.toHaveBeenCalled();
      });
    });

    describe('poisoned state', () => {
      beforeEach(() => stateIs({ poisoned: true }));

      it('always answers INVALID_RECOVERY_CODE', async () => {
        expect(await thrown(() => complete())).toMatchObject({
          status: 400,
          code: 'INVALID_RECOVERY_CODE',
        });
      });

      it('never calls upstream with a fabricated recovery', async () => {
        await thrown(() => complete());
        expect(mockUpstream.resetPassword).not.toHaveBeenCalled();
        expect(mockUpstream.resetPasswordVerify).not.toHaveBeenCalled();
      });

      it('counts attempts identically, so the lockout behaves the same', async () => {
        stateIs({ poisoned: true, attempts: 5 });
        expect(await thrown(() => complete())).toMatchObject({
          code: 'RECOVERY_LOCKED',
        });
      });

      it('still rejects a weak password first, so the ordering is identical', async () => {
        expect(await thrown(() => complete({ newPassword: 'abc' }))).toMatchObject({
          code: 'WEAK_PASSWORD',
        });
      });

      it('writes no audit row for a reset that never happened', async () => {
        await thrown(() => complete());
        expect(mockPrisma.credentialRecoveryAudit.create).not.toHaveBeenCalled();
      });
    });

    describe('upstream failures', () => {
      const CASES: Array<[string, number, string]> = [
        ['MfaCodeExpired', 400, 'RECOVERY_CODE_EXPIRED'],
        ['MfaExpired', 400, 'RECOVERY_CODE_EXPIRED'],
        ['MfaInvalidCode', 400, 'INVALID_RECOVERY_CODE'],
        ['MfaLocked', 429, 'RECOVERY_LOCKED'],
        ['UserSuspended', 422, 'CAPTCHA_REQUIRED'],
      ];

      for (const [reason, status, code] of CASES) {
        it(`maps ${reason} to ${status} ${code}`, async () => {
          mockUpstream.resetPassword.mockRejectedValue(reasonError(reason));
          expect(await thrown(() => complete())).toMatchObject({ status, code });
        });
      }

      it('maps a bare 404 to INVALID_RECOVERY_CODE', async () => {
        mockUpstream.resetPassword.mockRejectedValue(bareError(404));
        expect(await thrown(() => complete())).toMatchObject({
          status: 400,
          code: 'INVALID_RECOVERY_CODE',
        });
      });

      it('never renders an aborted request as an invalid code', async () => {
        // The parent has already burned a single-use code. A false "wrong
        // code" here is unrecoverable -- they cannot ask for that code again.
        jest.spyOn(axios, 'isCancel').mockReturnValue(true);
        mockUpstream.resetPassword.mockRejectedValue(new CanceledError('aborted'));
        expect(await thrown(() => complete())).toMatchObject({
          status: 502,
          code: 'UPSTREAM_ERROR',
        });
      });

      it('never renders an upstream 5xx as an invalid code', async () => {
        mockUpstream.resetPassword.mockRejectedValue(bareError(502));
        expect(await thrown(() => complete())).toMatchObject({
          status: 502,
          code: 'UPSTREAM_ERROR',
        });
      });

      it('keeps the recovery state alive after a wrong code, so the parent can retry', async () => {
        mockUpstream.resetPassword.mockRejectedValue(bareError(404));
        await thrown(() => complete());
        expect(mockRedis.del).not.toHaveBeenCalled();
      });
    });

    it('never answers 401 on any path', async () => {
      // `apiFetch` hard-redirects to /auth/sign-in on any 401 whose code is not
      // INVALID_CREDENTIALS, which would wipe the half-filled reset form.
      const failures: Array<() => void> = [
        () => mockRedis.get.mockResolvedValue(null),
        () => mockUpstream.resetPassword.mockRejectedValue(bareError(404)),
        () => mockUpstream.resetPassword.mockRejectedValue(bareError(401)),
        () => mockUpstream.resetPassword.mockRejectedValue(reasonError('MfaLocked')),
        () => mockUpstream.resetPassword.mockRejectedValue(reasonError('UserSuspended')),
      ];

      for (const arrange of failures) {
        jest.clearAllMocks();
        jest.spyOn(axios, 'isCancel').mockReturnValue(false);
        jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
        stateIs();
        arrange();
        expect((await thrown(() => complete())).status).not.toBe(401);
      }
    });
  });
});

/**
 * A reset invalidates the stored `encryptedPassword`, and without this the
 * breakage is SILENT: the sixteen sync crons keep decrypting a password Mashov
 * has already replaced, and the parent just sees their data stop updating.
 *
 * Two things have to happen, and the second is the one that is easy to forget:
 * mark the connection, and EVICT its in-memory session. The `MashovAuthToken`
 * cache is keyed `${connectionId}:${year}` and outlives the reset, so without
 * eviction the crons go on using a session authenticated with a password that
 * no longer exists.
 */
describe('CredentialRecoveryService stale-credential remediation', () => {
  let service: CredentialRecoveryService;

  const CONN = { id: 'conn-1' };
  const RID = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(
      mockEncryption.encrypt(
        JSON.stringify({
          semel: SEMEL,
          idNumber: ID,
          channel: 'email',
          isResettingAndVerifying: false,
          attempts: 0,
          poisoned: false,
        }),
      ),
    );
    mockUpstream.resetPassword.mockResolvedValue({ username: ID });
    mockPrisma.credentialRecoveryAudit.create.mockResolvedValue({});
    mockPrisma.householdConnection.findUnique.mockResolvedValue(CONN);
    mockPrisma.householdConnection.update.mockResolvedValue(CONN);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialRecoveryService,
        { provide: RedisService, useValue: mockRedis },
        { provide: MashovRecoveryService, useValue: mockUpstream },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MashovSessionService, useValue: mockSession },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();

    service = module.get(CredentialRecoveryService);
  });

  function complete() {
    return service.completePassword(
      RID,
      { code: 'ABC123', newPassword: GOOD_PASSWORD },
      IP,
    );
  }

  it('finds the connection by (schoolCode, username) with the ID number', async () => {
    // `idNumber` IS the Mashov username for these accounts: a login response
    // carries `credential.idNumber: 303977367` next to
    // `accessToken.username: "303977367"`, and the connection is uniquely
    // keyed on [schoolCode, username].
    await complete();

    expect(mockPrisma.householdConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolCode_username: { schoolCode: SEMEL, username: ID } },
      }),
    );
  });

  it('marks the connection stale', async () => {
    await complete();

    const update = mockPrisma.householdConnection.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: CONN.id });
    expect(update.data.credentialStaleAt).toBeInstanceOf(Date);
  });

  it('evicts the connection session, so no cron keeps using the old password', async () => {
    await complete();
    expect(mockSession.invalidateConnection).toHaveBeenCalledWith(CONN.id);
  });

  it('succeeds anyway when no connection matches', async () => {
    // Best-effort by design: a parent who set a custom username through
    // `CreateUsername` will not match, and their reset must still work.
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

    await expect(complete()).resolves.toEqual({ ok: true, username: ID });
    expect(mockPrisma.householdConnection.update).not.toHaveBeenCalled();
    expect(mockSession.invalidateConnection).not.toHaveBeenCalled();
  });

  it('still reports success when the marking itself fails', async () => {
    // The password has ALREADY changed upstream on a single-use code. Failing
    // the request now would tell the parent their reset did not work when it
    // did, and they could not repeat it.
    mockPrisma.householdConnection.update.mockRejectedValue(new Error('db down'));

    await expect(complete()).resolves.toEqual({ ok: true, username: ID });
  });

  it('marks nothing when the reset did not happen', async () => {
    mockUpstream.resetPassword.mockRejectedValue(bareError(404));

    await thrown(() => complete());

    expect(mockPrisma.householdConnection.update).not.toHaveBeenCalled();
    expect(mockSession.invalidateConnection).not.toHaveBeenCalled();
  });

  it('marks nothing for a fabricated recovery', async () => {
    mockRedis.get.mockResolvedValue(
      mockEncryption.encrypt(
        JSON.stringify({
          semel: SEMEL,
          idNumber: ID,
          channel: 'email',
          isResettingAndVerifying: false,
          attempts: 0,
          poisoned: true,
        }),
      ),
    );

    await thrown(() => complete());

    expect(mockPrisma.householdConnection.findUnique).not.toHaveBeenCalled();
    expect(mockSession.invalidateConnection).not.toHaveBeenCalled();
  });
});

/**
 * Fixes from the whole-branch review. Each of these reproduces a finding.
 */
describe('CredentialRecoveryService review fixes', () => {
  let service: CredentialRecoveryService;

  const RID = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.requestRecovery.mockResolvedValue({});
    mockUpstream.resetPassword.mockResolvedValue({ username: ID });
    mockPrisma.credentialRecoveryAudit.create.mockResolvedValue({});
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialRecoveryService,
        { provide: RedisService, useValue: mockRedis },
        { provide: MashovRecoveryService, useValue: mockUpstream },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MashovSessionService, useValue: mockSession },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();

    service = module.get(CredentialRecoveryService);
  });

  function stateIs(overrides: Record<string, unknown> = {}) {
    mockRedis.get.mockResolvedValue(
      mockEncryption.encrypt(
        JSON.stringify({
          semel: SEMEL,
          idNumber: ID,
          channel: 'email',
          isResettingAndVerifying: false,
          attempts: 0,
          poisoned: false,
          ...overrides,
        }),
      ),
    );
  }

  function complete() {
    return service.completePassword(
      RID,
      { code: 'ABC123', newPassword: GOOD_PASSWORD },
      IP,
    );
  }

  // I4 — a non-Mashov 4xx must never be blamed on the code.
  describe('a 4xx that did not come from Mashov', () => {
    function proxyError(status: number, contentType = 'text/html'): AxiosError {
      const err = new AxiosError('Forbidden', 'ERR_BAD_REQUEST');
      err.response = {
        status,
        data: '<html>Access denied</html>',
        headers: { 'content-type': contentType },
      } as unknown as AxiosError['response'];
      return err;
    }

    it('answers 502, not an invalid code, for a proxy ACL 403', async () => {
      // The egress proxy answers 403 with an HTML page and no Reason header.
      // Reported as a bad code it tells the parent their single-use code was
      // wrong, and they cannot ask for another.
      stateIs();
      mockUpstream.resetPassword.mockRejectedValue(proxyError(403));

      expect(await thrown(() => complete())).toMatchObject({
        status: 502,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('answers 502 for an HTML 404 from something in the middle', async () => {
      stateIs();
      mockUpstream.resetPassword.mockRejectedValue(proxyError(404));

      expect(await thrown(() => complete())).toMatchObject({
        code: 'UPSTREAM_ERROR',
      });
    });

    it('still blames the code for a JSON 404, which IS Mashov answering', async () => {
      stateIs();
      mockUpstream.resetPassword.mockRejectedValue(
        proxyError(404, 'application/json'),
      );

      expect(await thrown(() => complete())).toMatchObject({
        status: 400,
        code: 'INVALID_RECOVERY_CODE',
      });
    });

    it('does not fabricate a recovery at step 1 for a proxy 403 either', async () => {
      mockUpstream.requestRecovery.mockRejectedValue(proxyError(403));

      expect(
        await thrown(() =>
          service.start({ semel: SEMEL, idNumber: ID, channel: 'email' }, IP),
        ),
      ).toMatchObject({ status: 502, code: 'UPSTREAM_ERROR' });
    });
  });

  // I7 — a bare sha256 over a 9-digit space is a rainbow table away.
  describe('identity hashing', () => {
    it('uses a keyed HMAC, not a bare sha256 of the ID number', async () => {
      const keys: string[] = [];
      mockRedis.incr.mockImplementation((key: string) => {
        keys.push(key);
        return Promise.resolve(1);
      });

      await service.start({ semel: SEMEL, idNumber: ID, channel: 'email' }, IP);

      const bare = createHash('sha256').update(ID).digest('hex');
      expect(keys.join(' ')).not.toContain(bare);
      expect(keys[1]).toMatch(new RegExp(`^ratelimit:recovery:id:${SEMEL}:[0-9a-f]{64}$`));
    });

    it('hashes the audit row the same keyed way', async () => {
      stateIs();
      await complete();

      const row = mockPrisma.credentialRecoveryAudit.create.mock.calls[0][0].data;
      expect(row.idNumberHash).not.toBe(createHash('sha256').update(ID).digest('hex'));
      expect(row.idNumberHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // I8a — the raw ID number must not sit in a Redis value.
  describe('recovery state at rest', () => {
    it('stores no raw ID number in Redis', async () => {
      await service.start({ semel: SEMEL, idNumber: ID, channel: 'email' }, IP);

      const written = mockRedis.set.mock.calls[0][1] as string;
      expect(written).not.toContain(ID);
    });

    it('round-trips the state it wrote, so step 2 still works', async () => {
      // The encryption is only worth anything if the service can read its own
      // state back -- otherwise every recovery silently becomes "start again".
      await service.start({ semel: SEMEL, idNumber: ID, channel: 'email' }, IP);
      const written = mockRedis.set.mock.calls[0][1] as string;
      mockRedis.get.mockResolvedValue(written);

      await expect(complete()).resolves.toEqual({ ok: true, username: ID });
      expect(mockUpstream.resetPassword).toHaveBeenCalledWith('ABC123', GOOD_PASSWORD);
    });

    it('treats an unreadable state as expired rather than throwing', async () => {
      mockRedis.get.mockResolvedValue('not-valid-anything');

      expect(await thrown(() => complete())).toMatchObject({
        code: 'RECOVERY_SESSION_EXPIRED',
      });
    });
  });
});

describe('CredentialRecoveryService non-axios failures', () => {
  let service: CredentialRecoveryService;

  const RID = '66666666-6666-4666-8666-666666666666';

  beforeEach(async () => {
    jest.clearAllMocks();
    // Deliberately NOT stubbing `isAxiosError` to true here. Every other
    // describe in this file does, suite-wide, which means none of them can
    // exercise the branch where the thrown value is not an axios error at all
    // -- a `TypeError` inside the client, a thrown string, an aborted promise
    // rejecting with something unexpected. Those must read as an outage, not as
    // a bad code.
    jest.spyOn(axios, 'isCancel').mockReturnValue(false);
    mockRedis.incr.mockResolvedValue(1);
    mockUpstream.requestRecovery.mockResolvedValue({});
    mockPrisma.credentialRecoveryAudit.create.mockResolvedValue({});
    mockPrisma.householdConnection.findUnique.mockResolvedValue(null);
    mockRedis.get.mockResolvedValue(
      mockEncryption.encrypt(
        JSON.stringify({
          semel: SEMEL,
          idNumber: ID,
          channel: 'email',
          isResettingAndVerifying: false,
          attempts: 0,
          poisoned: false,
        }),
      ),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialRecoveryService,
        { provide: RedisService, useValue: mockRedis },
        { provide: MashovRecoveryService, useValue: mockUpstream },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MashovSessionService, useValue: mockSession },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();

    service = module.get(CredentialRecoveryService);
  });

  function complete() {
    return service.completePassword(
      RID,
      { code: 'ABC123', newPassword: GOOD_PASSWORD },
      IP,
    );
  }

  it('treats a plain Error from the client as an outage, not a bad code', async () => {
    mockUpstream.resetPassword.mockRejectedValue(new TypeError('x is not a function'));

    expect(await thrown(() => complete())).toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('treats a thrown non-Error the same way', async () => {
    mockUpstream.resetPassword.mockRejectedValue('something went wrong');

    expect(await thrown(() => complete())).toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('does not fabricate a recovery at step 1 for a non-axios failure', async () => {
    mockUpstream.requestRecovery.mockRejectedValue(new TypeError('boom'));

    expect(
      await thrown(() =>
        service.start({ semel: SEMEL, idNumber: ID, channel: 'email' }, IP),
      ),
    ).toMatchObject({ status: 502, code: 'UPSTREAM_ERROR' });
  });
});
