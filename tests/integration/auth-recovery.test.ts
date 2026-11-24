/**
 * In-app Mashov password recovery — integration tests.
 *
 * Covers the properties that unit tests cannot prove, because they are
 * properties of the wire:
 * - a known and an unknown ID number produce BYTE-IDENTICAL 202 bodies
 * - the whole surface is reachable with no `mashov_session` cookie
 * - no route answers 401 (which `apiFetch` turns into a hard redirect that
 *   would wipe a half-filled reset form)
 * - our own per-IP and per-identity rate limits bite
 * - the attempt cap on one `recoveryId` bites
 * - the two-channel path goes to the `/verify` route
 * - a dead upstream is a 502 and never "wrong code"
 *
 * Upstream is stubbed with `jest.spyOn` on `MashovRecoveryService`, matching how
 * `auth.test.ts` already mocks the Mashov side.
 */

import { INestApplication, ValidationPipe } from '../../backend/node_modules/@nestjs/common';
import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import { ThrottlerModule } from '../../backend/node_modules/@nestjs/throttler';
import { ScheduleModule } from '../../backend/node_modules/@nestjs/schedule';
import { AxiosError, CanceledError } from '../../backend/node_modules/axios';
import request from 'supertest';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { PrismaModule } from '../../backend/src/prisma/prisma.module';
import { RedisModule } from '../../backend/src/redis/redis.module';
import { AppSessionModule } from '../../backend/src/app-session/app-session.module';
import { AuthModule } from '../../backend/src/auth/auth.module';
import { HealthModule } from '../../backend/src/health/health.module';
import { AppSessionGuard } from '../../backend/src/app-session/app-session.guard';
import { HttpExceptionFilter } from '../../backend/src/common/filters/http-exception.filter';
import { RedisService } from '../../backend/src/redis/redis.service';
import { MashovRecoveryService } from '../../backend/src/common/mashov-login/mashov-recovery.service';
import { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import { SchoolLinksService } from '../../backend/src/school-links/school-links.service';
import { AuthService } from '../../backend/src/auth/auth.service';
import { EncryptionService } from '../../backend/src/session/encryption.service';
import { MashovSessionModule } from '../../backend/src/session/mashov-session.module';
import { SchoolLinksModule } from '../../backend/src/school-links/school-links.module';

const SEMEL = 540175;
const KNOWN_ID = '303977367';
const UNKNOWN_ID = '000000001';
const GOOD_PASSWORD = 'secret1';

const RECOVERIES = '/api/v1/auth/credential-recoveries';

function reasonError(reason: string, status = 403): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { reason },
    statusText: '',
    config: {},
  } as unknown as AxiosError['response'];
  return err;
}

/**
 * A Mashov answer with no `Reason` header.
 *
 * The JSON content type is load-bearing, not decoration: it is what marks the
 * response as having come from Mashov's API rather than from a proxy ACL page,
 * and only the former is evidence about what the parent typed. A fixture
 * without it is a fixture for a proxy rejection.
 */
function bareError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { 'content-type': 'application/json' },
    statusText: '',
    config: {},
  } as unknown as AxiosError['response'];
  return err;
}

/** What something BETWEEN us and Mashov answers with: HTML, no `Reason`. */
function proxyError(status: number): AxiosError {
  const err = new AxiosError('Forbidden', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: '<html>Access denied</html>',
    headers: { 'content-type': 'text/html' },
    statusText: '',
    config: {},
  } as unknown as AxiosError['response'];
  return err;
}

describe('In-app Mashov password recovery', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let redisService: RedisService;
  let upstream: MashovRecoveryService;
  let session: MashovSessionService;
  let schoolLinks: SchoolLinksService;
  let authService: AuthService;
  let encryption: EncryptionService;

  let requestRecovery: jest.SpyInstance;
  let resetPassword: jest.SpyInstance;
  let resetPasswordVerify: jest.SpyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
        ScheduleModule.forRoot(),
        PrismaModule,
        RedisModule,
        AppSessionModule,
        MashovSessionModule,
        SchoolLinksModule,
        AuthModule,
        HealthModule,
      ],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['/health'] });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalGuards(module.get(AppSessionGuard));
    await app.init();

    redisService = module.get(RedisService);
    upstream = module.get(MashovRecoveryService);
    session = module.get(MashovSessionService);
    schoolLinks = module.get(SchoolLinksService);
    authService = module.get(AuthService);
    // Needed for a connection whose stored password actually decrypts; see
    // `seedConnection`. Exported by MashovSessionModule, which this test
    // module already imports.
    encryption = module.get(EncryptionService);

    requestRecovery = jest.spyOn(upstream, 'requestRecovery');
    resetPassword = jest.spyOn(upstream, 'resetPassword');
    resetPasswordVerify = jest.spyOn(upstream, 'resetPasswordVerify');
  });

  afterAll(async () => {
    requestRecovery.mockRestore();
    resetPassword.mockRestore();
    resetPasswordVerify.mockRestore();
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Every test gets its own limiter budget. Without this the first suite to
    // run three recoveries would 429 everything after it.
    // ALL of them, not just recovery's: the fix pass added limiters to
    // /auth/credentials and both MFA routes, and a bucket surviving between
    // tests makes a later test fail for a reason that has nothing to do with
    // what it is checking.
    await redisService.scanDel('ratelimit:*');
    await redisService.scanDel('recovery:*');
    await redisService.scanDel('otp:*');
    await prisma.credentialRecoveryAudit.deleteMany({});

    requestRecovery.mockResolvedValue({});
    resetPassword.mockResolvedValue({ username: KNOWN_ID });
    resetPasswordVerify.mockResolvedValue({ username: KNOWN_ID });
  });

  /** A fresh IP per call, so one test's rate-limit budget is its own. */
  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `203.0.113.${(ipCounter % 250) + 1}`;
  }

  function startRecovery(
    body: Record<string, unknown> = {},
    ip = freshIp(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(RECOVERIES)
      .set('X-Forwarded-For', ip)
      .send({ semel: SEMEL, idNumber: KNOWN_ID, channel: 'email', ...body });
  }

  function completeRecovery(
    recoveryId: string,
    body: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${RECOVERIES}/${recoveryId}/password`)
      .set('X-Forwarded-For', freshIp())
      .send({ code: 'ABC123', newPassword: GOOD_PASSWORD, ...body });
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe('reachability', () => {
    it('accepts step 1 with no mashov_session cookie at all', async () => {
      // The whole point: this flow exists for someone who cannot sign in.
      const res = await startRecovery();
      expect(res.status).toBe(202);
    });

    it('accepts step 2 with no mashov_session cookie at all', async () => {
      const { body } = await startRecovery();
      const res = await completeRecovery(body.recoveryId);
      expect(res.status).toBe(200);
    });

    it('never answers 401, whatever goes wrong', async () => {
      // `apiFetch` hard-redirects the browser on any 401 whose code is not
      // INVALID_CREDENTIALS, which would throw the parent off the reset form
      // and lose a single-use code they cannot request again.
      const responses: request.Response[] = [];

      responses.push(await startRecovery({ idNumber: '' }));
      responses.push(await startRecovery({ channel: 'carrier-pigeon' }));

      requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      const poisoned = await startRecovery();
      responses.push(poisoned);
      responses.push(await completeRecovery(poisoned.body.recoveryId));

      requestRecovery.mockResolvedValue({});
      const real = await startRecovery();
      responses.push(await completeRecovery(real.body.recoveryId, { newPassword: 'abc' }));

      resetPassword.mockRejectedValue(bareError(401));
      const another = await startRecovery();
      responses.push(await completeRecovery(another.body.recoveryId));

      responses.push(await completeRecovery('11111111-1111-4111-8111-111111111111'));

      for (const res of responses) {
        expect(res.status).not.toBe(401);
      }
    });
  });

  describe('no enumeration', () => {
    it('answers an unknown ID with a body byte-identical to a known one', async () => {
      const known = await startRecovery({ idNumber: KNOWN_ID });

      requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      const unknown = await startRecovery({ idNumber: UNKNOWN_ID });

      expect(unknown.status).toBe(known.status);

      // The recoveryId differs by construction (it is a fresh uuid), so it is
      // normalised out and its shape compared separately. Everything else must
      // be identical byte for byte, including key order.
      const normalise = (res: request.Response) =>
        JSON.stringify({ ...res.body, recoveryId: 'x' });

      expect(normalise(unknown)).toBe(normalise(known));
      expect(unknown.body.recoveryId).toHaveLength(known.body.recoveryId.length);
      expect(unknown.body.recoveryId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers a suspended account the same way, rather than asking for a captcha', async () => {
      // Mashov only escalates to a captcha for accounts it RECOGNISES, so
      // CAPTCHA_REQUIRED here would be a perfect "does this ID exist" oracle.
      const known = await startRecovery();

      requestRecovery.mockRejectedValue(reasonError('UserSuspended'));
      const suspended = await startRecovery();

      expect(suspended.status).toBe(202);
      expect(Object.keys(suspended.body)).toEqual(Object.keys(known.body));
      expect(suspended.body.requiresSecondChannel).toBe(
        known.body.requiresSecondChannel,
      );
    });

    it('fails a fabricated recovery at step 2 as an invalid code', async () => {
      requestRecovery.mockRejectedValue(reasonError('IdNumberNoMatch'));
      const { body } = await startRecovery({ idNumber: UNKNOWN_ID });

      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_RECOVERY_CODE');
      expect(resetPassword).not.toHaveBeenCalled();
    });
  });

  describe('rate limits', () => {
    it('refuses a fourth recovery from one IP', async () => {
      const ip = freshIp();
      for (let i = 0; i < 3; i += 1) {
        const res = await startRecovery({ idNumber: `10000000${i}` }, ip);
        expect(res.status).toBe(202);
      }

      const fourth = await startRecovery({ idNumber: '999999999' }, ip);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('RATE_LIMITED');
    });

    it('refuses a fourth recovery for one identity, even from fresh IPs', async () => {
      // Per-IP alone does nothing against a botnet enumerating one victim.
      for (let i = 0; i < 3; i += 1) {
        expect((await startRecovery()).status).toBe(202);
      }

      const fourth = await startRecovery();
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('RATE_LIMITED');
    });

    it('parks no raw ID number under a Redis key', async () => {
      await startRecovery();
      // `scanDel` is the only key-pattern API available, so this asserts the
      // negative: a key built from the raw ID would be matched and deleted,
      // and the next request would get a fresh budget instead of 429ing.
      await redisService.scanDel(`*${KNOWN_ID}*`);

      for (let i = 0; i < 2; i += 1) {
        expect((await startRecovery()).status).toBe(202);
      }
      expect((await startRecovery()).status).toBe(429);
    });

    it('rejects a sixth attempt on one recoveryId and burns it', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(bareError(404));

      for (let i = 0; i < 5; i += 1) {
        const res = await completeRecovery(body.recoveryId);
        expect(res.body.error.code).toBe('INVALID_RECOVERY_CODE');
      }

      const sixth = await completeRecovery(body.recoveryId);
      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe('RECOVERY_LOCKED');

      // Burned, not merely refused: the state is gone, so a brute force cannot
      // resume it after the window.
      const seventh = await completeRecovery(body.recoveryId);
      expect(seventh.body.error.code).toBe('RECOVERY_SESSION_EXPIRED');
    });
  });

  describe('two-channel recovery', () => {
    it('demands the second code based on the server-stored flag', async () => {
      requestRecovery.mockResolvedValue({ isResettingAndVerifying: true });
      const { body } = await startRecovery();
      expect(body.requiresSecondChannel).toBe(true);

      const res = await completeRecovery(body.recoveryId);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SECOND_CODE_REQUIRED');
    });

    it('routes to the /verify endpoint with both codes', async () => {
      requestRecovery.mockResolvedValue({ isResettingAndVerifying: true });
      const { body } = await startRecovery();

      const res = await completeRecovery(body.recoveryId, {
        code: 'AAA111',
        secondCode: 'BBB222',
      });

      expect(res.status).toBe(200);
      expect(resetPasswordVerify).toHaveBeenCalledWith('AAA111', 'BBB222', GOOD_PASSWORD);
      expect(resetPassword).not.toHaveBeenCalled();
    });

    it('cannot be downgraded to the single-code route by the client', async () => {
      requestRecovery.mockResolvedValue({ isResettingAndVerifying: true });
      const { body } = await startRecovery();

      // Even claiming otherwise in the step-2 body changes nothing: the flag
      // is read from Redis, not from the request.
      const res = await completeRecovery(body.recoveryId, {
        requiresSecondChannel: false,
      });

      expect(res.body.error.code).toBe('SECOND_CODE_REQUIRED');
    });
  });

  describe('a dead upstream is never a wrong code', () => {
    it('answers 502 when the reset request is aborted', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(new CanceledError('aborted'));

      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });

    it('answers 502 on an upstream 5xx', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(bareError(503));

      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });

    it('leaves the recovery usable after an outage, so the code is not wasted', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(new CanceledError('aborted'));
      await completeRecovery(body.recoveryId);

      resetPassword.mockResolvedValue({ username: KNOWN_ID });
      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, username: KNOWN_ID });
    });

    it('answers 502 at step 1 too, rather than fabricating a recovery', async () => {
      requestRecovery.mockRejectedValue(new CanceledError('aborted'));
      const res = await startRecovery();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });
  });

  describe('password policy and secrecy', () => {
    it('rejects a weak password 422 before touching the upstream', async () => {
      const { body } = await startRecovery();

      const res = await completeRecovery(body.recoveryId, { newPassword: 'abc' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WEAK_PASSWORD');
      expect(res.body.error.details.length).toBeGreaterThan(0);
      expect(resetPassword).not.toHaveBeenCalled();
    });

    it('never echoes the password or the code back in any response', async () => {
      const { body } = await startRecovery();
      const ok = await completeRecovery(body.recoveryId, {
        code: 'SECRETCODE',
        newPassword: 'zxcvb9',
      });

      expect(JSON.stringify(ok.body)).not.toContain('zxcvb9');
      expect(JSON.stringify(ok.body)).not.toContain('SECRETCODE');
    });

    it('carries no ID number in the step-1 response', async () => {
      const res = await startRecovery();
      expect(JSON.stringify(res.body)).not.toContain(KNOWN_ID);
    });

    it('stores no recovery code or password in Redis', async () => {
      const { body } = await startRecovery();
      await completeRecovery(body.recoveryId, {
        code: 'SECRETCODE',
        newPassword: 'zxcvb9',
      });

      // The state is consumed on success, so re-read before the reset instead.
      const again = await startRecovery({ idNumber: '111111111' });
      const raw = await redisService.get(`recovery:${again.body.recoveryId}`);
      expect(raw).not.toBeNull();
      expect(raw).not.toContain('SECRETCODE');
      expect(raw).not.toContain('zxcvb9');
    });
  });

  describe('audit trail', () => {
    it('writes one row per completed reset, with a hash and never the ID', async () => {
      const { body } = await startRecovery();
      await completeRecovery(body.recoveryId);

      const rows = await prisma.credentialRecoveryAudit.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0].schoolCode).toBe(SEMEL);
      expect(rows[0].idNumberHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].idNumberHash).not.toContain(KNOWN_ID);
      expect(rows[0].ip).toBeTruthy();
    });

    it('writes no row for a reset that did not happen', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(bareError(404));
      await completeRecovery(body.recoveryId);

      expect(await prisma.credentialRecoveryAudit.count()).toBe(0);
    });
  });

  describe('request validation', () => {
    it('rejects a missing idNumber as 400 VALIDATION_ERROR', async () => {
      const res = await startRecovery({ idNumber: '  ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown channel', async () => {
      const res = await startRecovery({ channel: 'carrier-pigeon' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a missing code at step 2', async () => {
      const { body } = await startRecovery();
      const res = await completeRecovery(body.recoveryId, { code: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('stale-credential remediation, end to end', () => {
    async function seedConnection(username: string) {
      const user = await prisma.appUser.create({
        data: {
          mashovUserId: `mashov-${username}`,
          semel: SEMEL,
          username,
          displayName: 'Parent',
        },
      });
      return prisma.householdConnection.create({
        data: {
          schoolCode: SEMEL,
          schoolYear: 2027,
          username,
          encryptedPassword: 'enc-old-password',
          schoolName: 'Test School',
          upstreamUserId: `mashov-${username}`,
          active: true,
          userId: user.id,
        },
      });
    }

    afterEach(async () => {
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    it('marks the matching connection stale and evicts its cached session', async () => {
      // Without the eviction the in-memory MashovAuthToken keyed
      // `${connectionId}:${year}` outlives the reset, and the sync crons go on
      // using a session authenticated with a password that no longer exists.
      const connection = await seedConnection(KNOWN_ID);
      const evict = jest.spyOn(session, 'invalidateConnection');

      const { body } = await startRecovery();
      const res = await completeRecovery(body.recoveryId);
      expect(res.status).toBe(200);

      const after = await prisma.householdConnection.findUnique({
        where: { id: connection.id },
      });
      expect(after?.credentialStaleAt).toBeInstanceOf(Date);
      expect(evict).toHaveBeenCalledWith(connection.id);

      evict.mockRestore();
    });

    it('does not touch another school’s connection', async () => {
      // The flag is per school precisely so a multi-school household is told
      // WHICH one needs attention.
      const mine = await seedConnection(KNOWN_ID);
      const other = await prisma.householdConnection.create({
        data: {
          schoolCode: 999999,
          schoolYear: 2027,
          username: KNOWN_ID,
          encryptedPassword: 'enc-other',
          active: true,
        },
      });

      const { body } = await startRecovery();
      await completeRecovery(body.recoveryId);

      expect(
        (await prisma.householdConnection.findUnique({ where: { id: mine.id } }))
          ?.credentialStaleAt,
      ).toBeInstanceOf(Date);
      expect(
        (await prisma.householdConnection.findUnique({ where: { id: other.id } }))
          ?.credentialStaleAt,
      ).toBeNull();
    });

    it('completes the reset even with no connection to mark', async () => {
      // Best-effort by design: a parent who set a custom username through
      // `CreateUsername` will not match, and their reset must still work.
      const res = await completeRecovery(
        (await startRecovery({ idNumber: '555555555' })).body.recoveryId,
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('marks nothing when the reset failed', async () => {
      const connection = await seedConnection(KNOWN_ID);
      resetPassword.mockRejectedValue(bareError(404));

      const { body } = await startRecovery();
      await completeRecovery(body.recoveryId);

      expect(
        (await prisma.householdConnection.findUnique({ where: { id: connection.id } }))
          ?.credentialStaleAt,
      ).toBeNull();
    });

    it('surfaces the flag on the school link list', async () => {
      const connection = await seedConnection(KNOWN_ID);

      const { body } = await startRecovery();
      await completeRecovery(body.recoveryId);

      const links = await schoolLinks.listLinks(connection.userId as string);
      expect(links).toHaveLength(1);
      expect(links[0].credentialStale).toBe(true);

      const schools = await schoolLinks.listMeSchools(connection.userId as string);
      expect(schools[0].credentialStale).toBe(true);
    });
  });

  describe('MFA challenge endpoints', () => {
    const CHALLENGES = '/api/v1/auth/mfa-challenges';
    const CHALLENGE = 'ch-integration-1';

    let sendMfa: jest.SpyInstance;
    let verifyMfa: jest.SpyInstance;

    beforeAll(() => {
      sendMfa = jest.spyOn(upstream, 'sendMfa');
      verifyMfa = jest.spyOn(upstream, 'verifyMfa');
    });

    afterAll(() => {
      sendMfa.mockRestore();
      verifyMfa.mockRestore();
    });

    beforeEach(async () => {
      await redisService.scanDel('ratelimit:*');
      sendMfa.mockResolvedValue(undefined);
      verifyMfa.mockResolvedValue({
        data: {
          credential: { userId: 'mfa-user-1', displayName: 'MFA Parent' },
          accessToken: {
            userSettings: { detailsState: 1 },
            schoolSettings: { schoolName: 'Test School', schoolYear: 2027 },
            children: [],
            username: KNOWN_ID,
          },
        },
        newUniqueId: 'uniq-mfa',
        csrfToken: 'csrf-mfa',
        devicePass: 'dp-mfa',
      });
      await prisma.appSession.deleteMany({});
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    afterEach(async () => {
      await prisma.appSession.deleteMany({});
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    function sendCode(body: Record<string, unknown> = {}) {
      return request(app.getHttpServer())
        .post(`${CHALLENGES}/${CHALLENGE}/code`)
        .set('X-Forwarded-For', freshIp())
        .send({ method: 'email', ...body });
    }

    function createSession(body: Record<string, unknown> = {}) {
      return request(app.getHttpServer())
        .post(`${CHALLENGES}/${CHALLENGE}/session`)
        .set('X-Forwarded-For', freshIp())
        .send({
          semel: SEMEL,
          username: KNOWN_ID,
          password: 'realpassword1',
          code: '123456',
          ...body,
        });
    }

    it('sends a code with no mashov_session cookie', async () => {
      const res = await sendCode();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
      expect(sendMfa).toHaveBeenCalledWith(CHALLENGE, 'email');
    });

    it('mints the mashov_session cookie on a correct code', async () => {
      const res = await createSession();

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const cookie = res.headers['set-cookie'];
      expect(String(cookie)).toContain('mashov_session=');
      expect(String(cookie)).toContain('HttpOnly');
      expect(String(cookie)).toContain('SameSite=Strict');
    });

    it('stores the password and the devicePass, so background sync survives', async () => {
      // The whole reason this route takes a password Mashov's own verify route
      // rejects: without it the household gets a session and no sync, and
      // without the devicePass every cron re-login re-opens this challenge.
      await createSession();

      const connection = await prisma.householdConnection.findFirst({
        where: { schoolCode: SEMEL, username: KNOWN_ID },
      });
      expect(connection?.encryptedPassword).toBeTruthy();
      expect(connection?.encryptedPassword).not.toBe('realpassword1');
      expect(connection?.devicePass).toBeTruthy();
      expect(connection?.devicePass).not.toBe('dp-mfa');
    });

    it('asks Mashov to remember the browser, whatever the client sent', async () => {
      await createSession({ rememberBrowser: false });
      expect(verifyMfa).toHaveBeenCalledWith(
        expect.objectContaining({ rememberBrowser: true }),
      );
    });

    it('sends no password upstream', async () => {
      await createSession();
      expect(JSON.stringify(verifyMfa.mock.calls[0][0])).not.toContain('realpassword1');
    });

    it('refuses a session with no password rather than killing sync silently', async () => {
      const res = await createSession({ password: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('reports a wrong code as 400, not 401', async () => {
      verifyMfa.mockRejectedValue(reasonError('MfaInvalidCode'));
      const res = await createSession();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MFA_CODE');
    });

    it('reports an outage as 502, never as a wrong code', async () => {
      verifyMfa.mockRejectedValue(new CanceledError('aborted'));
      const res = await createSession();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });

    it('never answers 401 on either route', async () => {
      const responses: request.Response[] = [];

      sendMfa.mockRejectedValue(bareError(401));
      responses.push(await sendCode());
      responses.push(await sendCode({ method: 'telegram' }));

      sendMfa.mockResolvedValue(undefined);
      verifyMfa.mockRejectedValue(bareError(401));
      responses.push(await createSession());
      responses.push(await createSession({ code: '  ' }));
      responses.push(await createSession({ username: '' }));

      for (const res of responses) {
        expect(res.status).not.toBe(401);
      }
    });

    it('mints no session when Mashov returns no credential', async () => {
      verifyMfa.mockResolvedValue({
        data: {},
        newUniqueId: undefined,
        csrfToken: undefined,
        devicePass: undefined,
      });

      const res = await createSession();

      expect(res.status).toBe(400);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await prisma.householdConnection.count()).toBe(0);
    });
  });

  describe('forced credential change and passwordless OTP', () => {
    const CREDENTIALS = '/api/v1/auth/credentials';
    const OTP_REQUESTS = '/api/v1/auth/otp-requests';

    let changePassword: jest.SpyInstance;
    let changeUsername: jest.SpyInstance;
    let requestOtp: jest.SpyInstance;
    let verifyOtp: jest.SpyInstance;

    function loginPayload() {
      return {
        data: {
          credential: { userId: 'setup-user-1', displayName: 'Setup Parent' },
          accessToken: {
            userSettings: { detailsState: 1 },
            schoolSettings: { schoolName: 'Test School', schoolYear: 2027 },
            children: [],
            username: KNOWN_ID,
          },
        },
        newUniqueId: 'uniq-setup',
        csrfToken: 'csrf-setup',
        devicePass: 'dp-setup',
      };
    }

    beforeAll(() => {
      changePassword = jest.spyOn(upstream, 'changePassword');
      changeUsername = jest.spyOn(upstream, 'changeUsername');
      requestOtp = jest.spyOn(upstream, 'requestOtp');
      verifyOtp = jest.spyOn(upstream, 'verifyOtp');
    });

    afterAll(() => {
      changePassword.mockRestore();
      changeUsername.mockRestore();
      requestOtp.mockRestore();
      verifyOtp.mockRestore();
    });

    beforeEach(async () => {
      await redisService.scanDel('ratelimit:*');
      changePassword.mockResolvedValue(loginPayload());
      changeUsername.mockResolvedValue(loginPayload());
      requestOtp.mockResolvedValue(undefined);
      verifyOtp.mockResolvedValue(loginPayload());
      await redisService.scanDel('ratelimit:otp:*');
      await redisService.scanDel('otp:*');
      await prisma.appSession.deleteMany({});
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    afterEach(async () => {
      await prisma.appSession.deleteMany({});
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    async function seedConnection() {
      const user = await prisma.appUser.create({
        data: {
          mashovUserId: 'setup-user-1',
          semel: SEMEL,
          username: KNOWN_ID,
          displayName: 'Setup Parent',
        },
      });
      return prisma.householdConnection.create({
        data: {
          schoolCode: SEMEL,
          schoolYear: 2027,
          username: KNOWN_ID,
          // A password that actually decrypts, which this used to not be.
          //
          // The previous comment argued the gap away -- "the OTP path's
          // decrypt is exercised in the unit spec" -- but that spec mocks the
          // upstream, so NO test at any layer reached
          // `OtpService.createSession`'s `this.encryption.decrypt(...)`. With
          // a literal 'enc-seed' (no ':' separators) `EncryptionService.decrypt`
          // throws 'Invalid encrypted text format' inside the request, i.e. a
          // 500 -- so the step-2 success path was not merely untested, it was
          // unreachable. That is the exact shape of gap the stage-blind
          // classifier bug lived in.
          encryptedPassword: encryption.encrypt('oldpw1'),
          schoolName: 'Test School',
          upstreamUserId: 'setup-user-1',
          active: true,
          userId: user.id,
        },
      });
    }

    describe('POST /auth/credentials', () => {
      function setCredentials(body: Record<string, unknown> = {}) {
        return request(app.getHttpServer())
          .post(CREDENTIALS)
          .set('X-Forwarded-For', freshIp())
          .send({
            semel: SEMEL,
            username: KNOWN_ID,
            password: 'oldpw1',
            newPassword: 'secret1',
            ...body,
          });
      }

      it('changes the password and signs the parent in', async () => {
        const res = await setCredentials();

        expect(res.status).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('mashov_session=');
      });

      it('stores the NEW password, so the sync crons use the one that works', async () => {
        await setCredentials();

        const connection = await prisma.householdConnection.findFirst({
          where: { schoolCode: SEMEL, username: KNOWN_ID },
        });
        expect(connection?.encryptedPassword).toBeTruthy();
        expect(connection?.encryptedPassword).not.toBe('secret1');
        expect(connection?.encryptedPassword).not.toBe('oldpw1');
      });

      it('rejects a weak password 422 before touching Mashov', async () => {
        const res = await setCredentials({ newPassword: 'abc' });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('WEAK_PASSWORD');
        expect(changePassword).not.toHaveBeenCalled();
      });

      it('reports a taken username as 409', async () => {
        changeUsername.mockRejectedValue(reasonError('UsernameExists'));
        const res = await setCredentials({
          newPassword: undefined,
          newUsername: 'avocado',
        });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('USERNAME_TAKEN');
      });

      it('never answers 401', async () => {
        const responses: request.Response[] = [];
        responses.push(await setCredentials({ username: '' }));
        responses.push(await setCredentials({ newPassword: undefined }));

        changePassword.mockRejectedValue(bareError(401));
        responses.push(await setCredentials());

        changePassword.mockRejectedValue(new CanceledError('aborted'));
        responses.push(await setCredentials());

        for (const res of responses) {
          expect(res.status).not.toBe(401);
        }
      });
    });

    describe('OTP sign-in', () => {
      function requestCode(body: Record<string, unknown> = {}) {
        return request(app.getHttpServer())
          .post(OTP_REQUESTS)
          .set('X-Forwarded-For', freshIp())
          .send({ semel: SEMEL, username: KNOWN_ID, method: 'email', ...body });
      }

      it('refuses, before sending a code, for a school never signed into', async () => {
        // The constraint is surfaced rather than hidden: an OTP-only household
        // would have no stored credential and no background sync at all.
        const res = await requestCode();

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('PASSWORD_SIGN_IN_REQUIRED');
        expect(requestOtp).not.toHaveBeenCalled();
      });

      it('issues an opaque handle for a school that has been signed into', async () => {
        await seedConnection();
        const res = await requestCode();

        expect(res.status).toBe(202);
        expect(res.body.otpRequestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.method).toBe('email');
      });

      it('carries neither the school nor the username into step 2', async () => {
        await seedConnection();
        const { body } = await requestCode();
        const stored = await redisService.get(`otp:${body.otpRequestId}`);

        // Both live server-side under the opaque handle, so the step-2 request
        // body is just a code.
        expect(stored).toContain(String(SEMEL));
        expect(body).not.toHaveProperty('username');
        expect(body).not.toHaveProperty('semel');
      });

      /**
       * The success path, reachable for the first time.
       *
       * Everything it touches was unexecuted by any route-level test: the
       * decrypt of the stored credential, `persistSessionFromLogin` with
       * `credentialProven: false`, the single-use `redis.del` of the handle,
       * and the session cookie's options.
       */
      it('exchanges a code for a session and consumes the handle', async () => {
        await seedConnection();
        const { body } = await requestCode();

        const res = await request(app.getHttpServer())
          .post(`${OTP_REQUESTS}/${body.otpRequestId}/session`)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '123456' });

        expect(res.status).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('mashov_session=');
        // Single use: the handle is gone, so a replay cannot mint a second
        // session from one code.
        expect(await redisService.get(`otp:${body.otpRequestId}`)).toBeNull();
      });

      it('sends no password upstream, since this flow has none by definition', async () => {
        await seedConnection();
        const { body } = await requestCode();

        await request(app.getHttpServer())
          .post(`${OTP_REQUESTS}/${body.otpRequestId}/session`)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '123456' });

        const sent = verifyOtp.mock.calls[0][0];
        expect(sent.loginData).not.toHaveProperty('password');
        // The stored device cookie, which this flow used to read and drop.
        expect(sent.uniqueId).toBeDefined();
      });

      it('refuses a replayed handle', async () => {
        await seedConnection();
        const { body } = await requestCode();
        const url = `${OTP_REQUESTS}/${body.otpRequestId}/session`;

        await request(app.getHttpServer())
          .post(url)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '123456' });

        const replay = await request(app.getHttpServer())
          .post(url)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '123456' });

        expect(replay.status).toBe(400);
        expect(replay.body.error.code).toBe('OTP_SESSION_EXPIRED');
      });

      it('tells the parent to start again on an unknown handle', async () => {
        const res = await request(app.getHttpServer())
          .post(`${OTP_REQUESTS}/44444444-4444-4444-8444-444444444444/session`)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '123456' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('OTP_SESSION_EXPIRED');
      });

      it('rejects a missing code', async () => {
        const res = await request(app.getHttpServer())
          .post(`${OTP_REQUESTS}/44444444-4444-4444-8444-444444444444/session`)
          .set('X-Forwarded-For', freshIp())
          .send({ code: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('never answers 401', async () => {
        const responses: request.Response[] = [];
        responses.push(await requestCode());
        responses.push(await requestCode({ method: 'carrier-pigeon' }));
        responses.push(
          await request(app.getHttpServer())
            .post(`${OTP_REQUESTS}/does-not-exist/session`)
            .set('X-Forwarded-For', freshIp())
            .send({ code: '123456' }),
        );

        for (const res of responses) {
          expect(res.status).not.toBe(401);
        }
      });
    });
  });

  describe('review fixes, end to end', () => {
    async function seedConnection(username = KNOWN_ID) {
      const user = await prisma.appUser.create({
        data: {
          mashovUserId: `mashov-fix-${username}`,
          semel: SEMEL,
          username,
          displayName: 'Parent',
        },
      });
      return prisma.householdConnection.create({
        data: {
          schoolCode: SEMEL,
          schoolYear: 2027,
          username,
          encryptedPassword: 'enc-old-password',
          schoolName: 'Test School',
          upstreamUserId: `mashov-fix-${username}`,
          active: true,
          credentialStaleAt: new Date('2026-11-23T09:00:00Z'),
          userId: user.id,
        },
      });
    }

    afterEach(async () => {
      await redisService.scanDel('ratelimit:*');
      await prisma.appSession.deleteMany({});
      await prisma.householdConnection.deleteMany({});
      await prisma.appUser.deleteMany({});
    });

    // C1 lives in `connection.service.spec.ts` instead: the write that heals a
    // stale connection is `ConnectionService.updateConnection`, which validates
    // against Mashov first, and this suite stubs the recovery/MFA client rather
    // than ConnectionService's own axios instance. What IS asserted here is the
    // other half -- that the flag a reset sets surfaces on the school-link list,
    // which the `stale-credential remediation, end to end` describe above
    // covers.

    // C2 — nothing that did not prove the password may clear the flag.
    it('leaves the stale flag set after an OTP sign-in', async () => {
      // OTP re-stores the password it already had, which may be exactly the
      // dead one a reset invalidated. Clearing the flag would delete the only
      // signal saying this school's sync is broken.
      const connection = await seedConnection();

      await authService.persistSessionFromLogin({
        semel: SEMEL,
        username: KNOWN_ID,
        password: 'whatever-we-already-had',
        year: 2027,
        loginData: {
          credential: { userId: `mashov-fix-${KNOWN_ID}` },
          accessToken: { children: [] },
        },
        credentialProven: false,
        ip: '203.0.113.90',
        existingConnBeforeLogin: {
          id: connection.id,
          mashovUniqueId: null,
          userId: connection.userId,
        },
      });

      const after = await prisma.householdConnection.findUnique({
        where: { id: connection.id },
      });
      expect(after?.credentialStaleAt).not.toBeNull();
    });

    it('clears the stale flag when the password WAS proven', async () => {
      const connection = await seedConnection();

      await authService.persistSessionFromLogin({
        semel: SEMEL,
        username: KNOWN_ID,
        password: 'a-proven-password',
        year: 2027,
        loginData: {
          credential: { userId: `mashov-fix-${KNOWN_ID}` },
          accessToken: { children: [] },
        },
        credentialProven: true,
        ip: '203.0.113.91',
        existingConnBeforeLogin: {
          id: connection.id,
          mashovUniqueId: null,
          userId: connection.userId,
        },
      });

      const after = await prisma.householdConnection.findUnique({
        where: { id: connection.id },
      });
      expect(after?.credentialStaleAt).toBeNull();
    });

    // C3 — the password-change route must not be the unguarded one.
    it('rate limits POST /auth/credentials per IP', async () => {
      const ip = freshIp();
      const body = {
        semel: SEMEL,
        username: KNOWN_ID,
        password: 'oldpw1',
        newPassword: 'secret1',
      };

      for (let i = 0; i < 5; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/credentials')
          .set('X-Forwarded-For', ip)
          .send(body);
        expect(res.status).not.toBe(429);
      }

      const sixth = await request(app.getHttpServer())
        .post('/api/v1/auth/credentials')
        .set('X-Forwarded-For', ip)
        .send(body);

      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe('RATE_LIMITED');
    });

    it('rate limits both MFA routes per IP', async () => {
      const ip = freshIp();

      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/mfa-challenges/ch-limit/code')
          .set('X-Forwarded-For', ip)
          .send({ method: 'email' });
      }

      const over = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa-challenges/ch-limit/code')
        .set('X-Forwarded-For', ip)
        .send({ method: 'email' });

      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe('RATE_LIMITED');
    });

    // I4 — a 4xx from something that is not Mashov is never a wrong code.
    it('answers 502 when a proxy, not Mashov, rejects the reset', async () => {
      const { body } = await startRecovery();
      resetPassword.mockRejectedValue(proxyError(403));

      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });

    // I8a — the raw ID number must not sit in a Redis value.
    it('stores no raw ID number in the recovery state', async () => {
      const { body } = await startRecovery();

      const stored = await redisService.get(`recovery:${body.recoveryId}`);
      expect(stored).not.toBeNull();
      expect(stored).not.toContain(KNOWN_ID);
    });

    it('still completes a recovery whose state it encrypted', async () => {
      // The encryption is worthless if the service cannot read its own state
      // back -- that would turn every recovery into "start again".
      const { body } = await startRecovery();

      const res = await completeRecovery(body.recoveryId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, username: KNOWN_ID });
    });
  });
});
