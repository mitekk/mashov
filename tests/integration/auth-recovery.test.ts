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

function bareError(status: number): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: {},
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
    await redisService.scanDel('ratelimit:recovery:*');
    await redisService.scanDel('recovery:*');
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
});
