/**
 * Operator feedback triage — integration tests.
 *
 * What a mocked Prisma cannot show, and what this file is for:
 *
 *  1. The guard as a real HTTP boundary. Specifically that an unauthenticated
 *     admin call answers **403 and not 401** — a 401 is what
 *     `frontend/src/api/client.ts` turns into a hard redirect to the PARENT
 *     sign-in page, so the status is a contract, not a detail.
 *  2. `@Public()` + `@UseGuards(CloudflareAccessGuard)` composing the way the
 *     controller's doc comment claims: the global `AppSessionGuard` stands down
 *     and the Access guard still runs. Nothing but a real request through both
 *     guards proves the ordering.
 *  3. The filter predicates as real SQL over real nulls, with the pagination
 *     totals counted over the filtered set.
 *  4. `readAt` as a side effect of a GET, stamped once and not re-stamped.
 *
 * The Access JWT is signed here with a throwaway RS256 keypair and verified
 * against a LOCAL JWK set, so nothing in this file reaches Cloudflare.
 *
 * `ThrottlerGuard` is deliberately not registered, as in `feedback.test.ts`.
 */

import { INestApplication, ValidationPipe } from '../../backend/node_modules/@nestjs/common';
import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from '../../backend/node_modules/jose';
import type { KeyLike } from '../../backend/node_modules/jose';
import request from 'supertest';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { PrismaModule } from '../../backend/src/prisma/prisma.module';
import { RedisModule } from '../../backend/src/redis/redis.module';
import { AppSessionModule } from '../../backend/src/app-session/app-session.module';
import { AppSessionGuard } from '../../backend/src/app-session/app-session.guard';
import { AdminFeedbackModule } from '../../backend/src/admin-feedback/admin-feedback.module';
import { AdminAuthModule } from '../../backend/src/admin-auth/admin-auth.module';
import {
  ADMIN_AUTH_CONFIG,
  type AdminAuthConfig,
} from '../../backend/src/admin-auth/admin-auth.config';
import {
  ACCESS_JWT_HEADER,
  ADMIN_ACCESS_JWKS,
} from '../../backend/src/admin-auth/cloudflare-access.guard';
import { HttpExceptionFilter } from '../../backend/src/common/filters/http-exception.filter';

const TEAM = 'https://mashov-test.cloudflareaccess.com';
const AUD = 'f'.repeat(64);
const USER = 'afb-user-1';

/** Three rows covering every cell of the triage matrix. */
const NEW_WITH_EMAIL = 'afb-new-email';
const READ_WITH_EMAIL = 'afb-read-email';
const NEW_NO_EMAIL = 'afb-new-noemail';

interface Row {
  id: string;
  contactEmail: string | null;
  readAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
}

const ROWS: Row[] = [
  {
    id: NEW_WITH_EMAIL,
    contactEmail: 'parent@example.com',
    readAt: null,
    respondedAt: null,
    createdAt: new Date('2026-11-28T10:00:00.000Z'),
  },
  {
    id: READ_WITH_EMAIL,
    contactEmail: 'other@example.com',
    readAt: new Date('2026-11-28T09:30:00.000Z'),
    respondedAt: null,
    createdAt: new Date('2026-11-28T09:00:00.000Z'),
  },
  {
    id: NEW_NO_EMAIL,
    contactEmail: null,
    readAt: null,
    respondedAt: new Date('2026-11-28T08:30:00.000Z'),
    createdAt: new Date('2026-11-28T08:00:00.000Z'),
  },
];

describe('/api/v1/admin/feedback', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let privateKey: KeyLike;

  async function token(
    options: { audience?: string; issuer?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(options.issuer ?? TEAM)
      .setAudience(options.audience ?? AUD)
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(privateKey);
  }

  beforeAll(async () => {
    // Pinned here rather than read from config: `.env` leaks into the
    // integration container, so a value present on the dev machine would
    // silently decide what this file is testing.
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256' }] });

    const config: AdminAuthConfig = {
      mode: 'verify',
      accessAud: AUD,
      accessTeamDomain: TEAM,
      ready: true,
    };

    prisma = new PrismaClient();
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        // AppSessionService resolves RedisService from the @Global RedisModule.
        // Registered precisely so the global AppSessionGuard below is the REAL
        // one: @Public() has to stand it down for an operator to get through.
        RedisModule,
        AppSessionModule,
        // @Global(), so its providers reach AdminFeedbackModule's controller
        // without an import edge -- exactly as in the real app. The GUARD is
        // the real class; only its two inputs are substituted, because the
        // real config factory reads process.env (which `.env` leaks into this
        // container) and the real key source would call Cloudflare.
        AdminAuthModule,
        AdminFeedbackModule,
      ],
    })
      .overrideProvider(ADMIN_AUTH_CONFIG)
      .useValue(config)
      .overrideProvider(ADMIN_ACCESS_JWKS)
      .useValue(keys)
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['/health'] });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: false } }),
    );
    app.useGlobalGuards(module.get(AppSessionGuard));
    await app.init();

    await prisma.feedback.deleteMany({});
    await prisma.appUser.deleteMany({ where: { id: USER } });
    await prisma.appUser.create({
      data: {
        id: USER,
        mashovUserId: 'mashov-afb',
        semel: 540175,
        username: 'parent-one',
        displayName: 'הורה',
      },
    });
  });

  afterAll(async () => {
    await prisma.feedback.deleteMany({});
    await prisma.appUser.deleteMany({ where: { id: USER } });
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.feedback.deleteMany({});
    for (const row of ROWS) {
      await prisma.feedback.create({
        data: {
          id: row.id,
          userId: USER,
          subject: 'bug',
          content: `report ${row.id}`,
          contactEmail: row.contactEmail,
          readAt: row.readAt,
          respondedAt: row.respondedAt,
          createdAt: row.createdAt,
          mashovUserId: 'mashov-afb',
          username: 'parent-one',
          displayName: 'הורה',
          schoolsSnapshot: [
            {
              id: 'conn-1',
              schoolCode: 540175,
              schoolName: 'תיכון הרצוג',
              label: 'הרצוג',
              schoolYear: 2026,
            },
          ],
        },
      });
    }
  });

  describe('authorization', () => {
    it('answers 403, NOT 401, to a request with no Access token', async () => {
      // 401 would make apiFetch redirect the operator to the parent sign-in
      // page, which looks like a broken screen rather than a refused request.
      const response = await request(app.getHttpServer()).get('/api/v1/admin/feedback');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: { code: 'FORBIDDEN', message: expect.any(String), details: [] },
      });
    });

    it.each([
      ['a malformed token', 'not.a.jwt'],
      ['an empty token', ''],
    ])('answers 403 to %s', async (_label, value) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, value);

      expect(response.status).toBe(403);
    });

    it('answers 403 to a token for another audience', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, await token({ audience: 'e'.repeat(64) }));

      expect(response.status).toBe(403);
    });

    it('answers 403 to an expired token', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, await token({ expiresIn: '-1m' }));

      expect(response.status).toBe(403);
    });

    it('never leaks the verification reason', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, 'not.a.jwt');

      expect(JSON.stringify(response.body)).not.toMatch(/jose|JWS|signature|audience/i);
    });

    it('lets a valid token through the global parent-session guard', async () => {
      // The composition under test: @Public() stands AppSessionGuard down, and
      // CloudflareAccessGuard is what admits the request. No mashov_session
      // cookie is sent anywhere in this file.
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, await token());

      expect(response.status).toBe(200);
    });

    it('still guards the detail and the response transition', async () => {
      const server = app.getHttpServer();
      expect((await request(server).get(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}`)).status).toBe(403);
      expect(
        (await request(server).post(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}/response`)).status,
      ).toBe(403);
    });
  });

  describe('GET /admin/feedback', () => {
    it('returns every row newest first, with the standard envelope', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      expect(response.body.data.map((item: { id: string }) => item.id)).toEqual([
        NEW_WITH_EMAIL,
        READ_WITH_EMAIL,
        NEW_NO_EMAIL,
      ]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
      });
    });

    it('omits the report text and keeps the nulls explicit', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback')
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      const [first] = response.body.data;
      expect(first).not.toHaveProperty('content');
      expect(first).toMatchObject({
        hasContactEmail: true,
        schools: ['הרצוג (540175)'],
        readAt: null,
        respondedAt: null,
        notifiedAt: null,
      });
      expect(first.createdAt).toBe('2026-11-28T10:00:00.000Z');
    });

    it('filter=new returns only the rows nobody has opened', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback?filter=new')
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      expect(response.body.data.map((item: { id: string }) => item.id)).toEqual([
        NEW_WITH_EMAIL,
        NEW_NO_EMAIL,
      ]);
      // Counted over the filtered set, so the total matches the page.
      expect(response.body.pagination.total).toBe(2);
    });

    it('filter=awaiting returns only answerable rows with no answer recorded', async () => {
      // NEW_NO_EMAIL has no reply address, so it can never be answered and
      // must not sit in this lens forever.
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback?filter=awaiting')
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      expect(response.body.data.map((item: { id: string }) => item.id)).toEqual([
        NEW_WITH_EMAIL,
        READ_WITH_EMAIL,
      ]);
      expect(response.body.pagination.total).toBe(2);
    });

    it('pages with real offsets', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback?page=2&limit=2')
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      expect(response.body.data.map((item: { id: string }) => item.id)).toEqual([NEW_NO_EMAIL]);
      expect(response.body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
    });

    it.each([
      ['an unknown filter', 'filter=handled'],
      ['a zero page', 'page=0'],
      ['a limit over the ceiling', 'limit=101'],
    ])('400s on %s rather than silently widening the view', async (_label, query) => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/feedback?${query}`)
        .set(ACCESS_JWT_HEADER, await token());

      expect(response.status).toBe(400);
    });
  });

  describe('GET /admin/feedback/:id', () => {
    it('returns the whole row, delivery state included', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}`)
        .set(ACCESS_JWT_HEADER, await token())
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: NEW_WITH_EMAIL,
        content: `report ${NEW_WITH_EMAIL}`,
        contactEmail: 'parent@example.com',
        notifyAttempts: 0,
        notifyError: null,
        notifiedAt: null,
      });
    });

    it('stamps readAt on the first open and does not re-stamp it', async () => {
      const server = app.getHttpServer();
      const auth = await token();

      const first = await request(server)
        .get(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      expect(first.body.data.readAt).not.toBeNull();

      // And it has left the "new" lens for good.
      const list = await request(server)
        .get('/api/v1/admin/feedback?filter=new')
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      expect(list.body.data.map((item: { id: string }) => item.id)).toEqual([NEW_NO_EMAIL]);

      const second = await request(server)
        .get(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      expect(second.body.data.readAt).toBe(first.body.data.readAt);
    });

    it('404s for an id that does not exist', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/feedback/does-not-exist')
        .set(ACCESS_JWT_HEADER, await token());

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /admin/feedback/:id/response', () => {
    it('records the answer and empties the awaiting lens', async () => {
      const server = app.getHttpServer();
      const auth = await token();

      const responded = await request(server)
        .post(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}/response`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      expect(responded.body.data.respondedAt).not.toBeNull();
      // A row can never be both answered and unread.
      expect(responded.body.data.readAt).not.toBeNull();

      await request(server)
        .post(`/api/v1/admin/feedback/${READ_WITH_EMAIL}/response`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);

      const list = await request(server)
        .get('/api/v1/admin/feedback?filter=awaiting')
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      expect(list.body.data).toEqual([]);
      expect(list.body.pagination.total).toBe(0);
    });

    it('keeps the original timestamp when called twice', async () => {
      const server = app.getHttpServer();
      const auth = await token();

      const first = await request(server)
        .post(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}/response`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);
      const second = await request(server)
        .post(`/api/v1/admin/feedback/${NEW_WITH_EMAIL}/response`)
        .set(ACCESS_JWT_HEADER, auth)
        .expect(200);

      expect(second.body.data.respondedAt).toBe(first.body.data.respondedAt);
    });

    it('404s for an id that does not exist', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/feedback/does-not-exist/response')
        .set(ACCESS_JWT_HEADER, await token());

      expect(response.status).toBe(404);
    });
  });
});
