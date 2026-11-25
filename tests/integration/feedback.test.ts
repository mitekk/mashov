/**
 * Parent feedback channel — integration tests.
 *
 * What a mocked Prisma cannot show, and what this file is for:
 *
 *  1. The DTO rules as the REAL ValidationPipe applies them. `whitelist: true`
 *     strips only undecorated properties and `@ValidateIf` merely skips a
 *     field, so "a stray `subjectOther` on a non-`other` subject persists
 *     null" is a claim about the pipe and the service together.
 *  2. The user agent the SERVER read, as a stored column — the client sends no
 *     such field, so nothing but a real request proves the value arrived.
 *  3. The per-user hourly limit as a row count against a real table.
 *  4. The schools snapshot as real JSONB, resolved over a real two-school
 *     household.
 *
 * `ThrottlerGuard` is deliberately NOT registered here. The `@Throttle`
 * decorator on the route is inert without it — which is exactly the reason the
 * limit that matters is counted per user in the service rather than per IP by
 * the guard. Registering it would also make every test in this file share one
 * IP budget.
 */

import { INestApplication, ValidationPipe } from '../../backend/node_modules/@nestjs/common';
import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import request from 'supertest';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { PrismaModule } from '../../backend/src/prisma/prisma.module';
import { RedisModule } from '../../backend/src/redis/redis.module';
import { AppSessionModule } from '../../backend/src/app-session/app-session.module';
import { AppSessionGuard } from '../../backend/src/app-session/app-session.guard';
import { FeedbackModule } from '../../backend/src/feedback/feedback.module';
import { HttpExceptionFilter } from '../../backend/src/common/filters/http-exception.filter';
import { FEEDBACK_MAX_PER_HOUR } from '../../backend/src/feedback/feedback.service';
import { FeedbackNotifierService } from '../../backend/src/feedback/feedback-notifier.service';

const USER = 'fb-user-1';
const OTHER_USER = 'fb-user-2';
const TOKEN = 'fb-session-token-1';
const OTHER_TOKEN = 'fb-session-token-2';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15';

/**
 * Two schools in one cluster, sharing everything up to the " - …" qualifier.
 * The short label collides, so both must snapshot their full names.
 */
const CONN_A = 'fb-conn-a';
const CONN_B = 'fb-conn-b';

interface SnapshotEntry {
  id: string;
  schoolCode: number;
  schoolName: string | null;
  label: string;
  schoolYear: number;
}

describe('POST /api/v1/feedback', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let notifier: FeedbackNotifierService;

  beforeAll(async () => {
    // Pinned rather than trusted from config: `.env` leaks into the
    // integration container, and a real chat id present on the dev machine
    // would turn these tests into live Telegram sends. Unset is also the state
    // this file asserts about -- the write path must be complete and
    // unaffected with no notifier configured.
    //
    // Both halves of the address, because either one alone is enough to make a
    // send attempt: the bot token (which bot) and the chat id (which chat).
    delete process.env.FEEDBACK_TELEGRAM_CHAT_ID;
    delete process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;

    prisma = new PrismaClient();
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        // AppSessionService resolves RedisService from the @Global RedisModule.
        RedisModule,
        AppSessionModule,
        FeedbackModule,
      ],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['/health'] });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalGuards(module.get(AppSessionGuard));
    notifier = module.get(FeedbackNotifierService);
    await app.init();

    await prisma.feedback.deleteMany({});
    await prisma.appSession.deleteMany({});
    await prisma.householdConnection.deleteMany({});
    await prisma.appUser.deleteMany({});

    for (const [id, username, displayName] of [
      [USER, 'parent-one', 'קורס דמיטרי [מיקה ז8]'],
      [OTHER_USER, 'parent-two', 'הורה שני'],
    ] as const) {
      await prisma.appUser.create({
        data: { id, mashovUserId: `mashov-${id}`, semel: 540175, username, displayName },
      });
    }

    for (const [token, userId] of [
      [TOKEN, USER],
      [OTHER_TOKEN, OTHER_USER],
    ] as const) {
      await prisma.appSession.create({
        data: {
          userId,
          sessionToken: token,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          lastActivityAt: new Date(),
        },
      });
    }

    await prisma.householdConnection.create({
      data: {
        id: CONN_A,
        userId: USER,
        schoolCode: 111111,
        schoolYear: 2027,
        username: 'cred-a',
        encryptedPassword: 'x',
        schoolName: 'אורט רמון - חינוך מיוחד',
        active: true,
      },
    });
    await prisma.householdConnection.create({
      data: {
        id: CONN_B,
        userId: USER,
        schoolCode: 222222,
        schoolYear: 2026,
        username: 'cred-b',
        encryptedPassword: 'x',
        schoolName: 'אורט רמון - תיכון',
        active: true,
      },
    });
    // Inactive: an unlinked school must not reach a new snapshot.
    await prisma.householdConnection.create({
      data: {
        id: 'fb-conn-gone',
        userId: USER,
        schoolCode: 333333,
        schoolYear: 2026,
        username: 'cred-gone',
        encryptedPassword: 'x',
        schoolName: 'בית ספר שבוטל',
        active: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.feedback.deleteMany({});
    await prisma.appSession.deleteMany({});
    await prisma.householdConnection.deleteMany({});
    await prisma.appUser.deleteMany({});
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.feedback.deleteMany({});
  });

  function send(body: Record<string, unknown>, token: string | null = TOKEN) {
    const req = request(app.getHttpServer())
      .post('/api/v1/feedback')
      .set('User-Agent', UA)
      .send(body);
    return token ? req.set('Cookie', `mashov_session=${token}`) : req;
  }

  it('refuses an unauthenticated report', async () => {
    const res = await send({ subject: 'bug', content: 'משהו לא עובד' }, null);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await prisma.feedback.count()).toBe(0);
  });

  it('stores the report with everything the server captured', async () => {
    const res = await send({
      subject: 'data',
      content: '  הציון בחשבון שגוי  ',
      contactEmail: 'parent@example.com',
      pagePath: '/children/abc',
      viewportWidth: 360,
      viewportHeight: 780,
      appVersion: '2026.11.23',
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ subject: 'data' });
    expect(typeof res.body.data.id).toBe('string');
    expect(typeof res.body.data.createdAt).toBe('string');
    // Nothing the parent wrote is echoed back.
    expect(JSON.stringify(res.body)).not.toContain('הציון');

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(row).toMatchObject({
      userId: USER,
      subject: 'data',
      subjectOther: null,
      contactEmail: 'parent@example.com',
      // Trimmed by the DTO's @Transform, before the length rules.
      content: 'הציון בחשבון שגוי',
      pagePath: '/children/abc',
      viewportWidth: 360,
      viewportHeight: 780,
      appVersion: '2026.11.23',
      mashovUserId: `mashov-${USER}`,
      username: 'parent-one',
      // parentDisplayName: the child's class tag is not persisted.
      displayName: 'קורס דמיטרי',
    });
    // Read from the request header, not from the body.
    expect(row.userAgent).toBe(UA);
  });

  it('snapshots the active schools with both full names when the short label collides', async () => {
    const res = await send({ subject: 'bug', content: 'תקלה' });

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    const snapshot = row.schoolsSnapshot as unknown as SnapshotEntry[];

    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((entry) => entry.id).sort()).toEqual([CONN_A, CONN_B]);
    for (const entry of snapshot) {
      // A collision reverts BOTH sides to the full name.
      expect(entry.label).toBe(entry.schoolName);
    }
    expect(snapshot.find((entry) => entry.id === CONN_A)).toMatchObject({
      schoolCode: 111111,
      schoolYear: 2027,
    });
  });

  it('snapshots an empty list for a household with no active connection', async () => {
    const res = await send({ subject: 'bug', content: 'תקלה' }, OTHER_TOKEN);

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(row.schoolsSnapshot).toEqual([]);
  });

  it('keeps the parent-written label when the subject is other', async () => {
    const res = await send({
      subject: 'other',
      subjectOther: 'הדף נטען לאט',
      content: 'לוקח המון זמן',
    });

    expect(res.status).toBe(201);
    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(row.subjectOther).toBe('הדף נטען לאט');
  });

  /**
   * The pipe does not strip it (it is decorated) and does not reject it
   * (`@ValidateIf` skips the field), so the service is the only thing between
   * the client and a label that belongs to no subject.
   */
  it('persists null for a stray label on a non-other subject', async () => {
    const res = await send({
      subject: 'timetable',
      subjectOther: 'label that belongs to nothing',
      content: 'המערכת לא מתעדכנת',
    });

    expect(res.status).toBe(201);
    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(row.subjectOther).toBeNull();
  });

  describe('validation', () => {
    const CASES: Array<{ name: string; body: Record<string, unknown>; field: string }> = [
      {
        name: 'a subject that is not on the list',
        body: { subject: 'rant', content: 'משהו' },
        field: 'subject',
      },
      {
        name: 'the subject other with no label',
        body: { subject: 'other', content: 'משהו' },
        field: 'subjectOther',
      },
      {
        name: 'a label longer than 80 characters',
        body: { subject: 'other', subjectOther: 'א'.repeat(81), content: 'משהו' },
        field: 'subjectOther',
      },
      {
        name: 'content that is only whitespace',
        body: { subject: 'bug', content: '    ' },
        field: 'content',
      },
      {
        name: 'missing content',
        body: { subject: 'bug' },
        field: 'content',
      },
      {
        name: 'content longer than 2000 characters',
        body: { subject: 'bug', content: 'א'.repeat(2001) },
        field: 'content',
      },
      {
        name: 'an email that is not an email',
        body: { subject: 'bug', content: 'משהו', contactEmail: 'not-an-email' },
        field: 'contactEmail',
      },
      {
        name: 'a page path longer than 200 characters',
        body: { subject: 'bug', content: 'משהו', pagePath: `/${'a'.repeat(200)}` },
        field: 'pagePath',
      },
      {
        name: 'an app version longer than 40 characters',
        body: { subject: 'bug', content: 'משהו', appVersion: 'v'.repeat(41) },
        field: 'appVersion',
      },
      /**
       * Unbounded, `Int` maps to Postgres INTEGER and the driver raises
       * "integer out of range", which the catch-all filter turns into a 500 --
       * a status `.claude/rules/api.md` reserves for the genuinely
       * unexpected. Not reachable from a browser, where `window.innerWidth` is
       * screen-bounded, but a hand-made request is all it takes.
       */
      {
        name: 'a viewport wider than any screen',
        body: { subject: 'bug', content: 'משהו', viewportWidth: 3_000_000_000 },
        field: 'viewportWidth',
      },
      {
        name: 'a viewport taller than any screen',
        body: { subject: 'bug', content: 'משהו', viewportHeight: 3_000_000_000 },
        field: 'viewportHeight',
      },
      {
        name: 'a negative viewport',
        body: { subject: 'bug', content: 'משהו', viewportWidth: -1 },
        field: 'viewportWidth',
      },
    ];

    it.each(CASES)('refuses $name', async ({ body, field }) => {
      const res = await send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.error.details)).toContain(field);
      expect(await prisma.feedback.count()).toBe(0);
    });
  });

  /** Per user, counted against the table — not per IP. */
  it(`refuses report number ${FEEDBACK_MAX_PER_HOUR + 1} within the hour`, async () => {
    for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i += 1) {
      const accepted = await send({ subject: 'bug', content: `דיווח ${i}` });
      expect(accepted.status).toBe(201);
    }

    const refused = await send({ subject: 'bug', content: 'אחד יותר מדי' });

    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(await prisma.feedback.count({ where: { userId: USER } })).toBe(
      FEEDBACK_MAX_PER_HOUR,
    );

    // The other parent, on the same IP, is unaffected.
    const neighbour = await send({ subject: 'bug', content: 'שלי' }, OTHER_TOKEN);
    expect(neighbour.status).toBe(201);
  });

  /**
   * The outbox columns, as a new row actually lands.
   *
   * The write path gained a notifier and must be unchanged by it: the report
   * is stored, the parent gets their 201, and nothing in the request sends
   * anything. The row is left pending for the cron to pick up, which is the
   * whole point of the outbox -- `create()` has no hook point at all.
   */
  it('writes a new report as pending delivery, untriaged, with no chat configured', async () => {
    const response = await send({ subject: 'bug', content: 'דיווח חדש' });
    expect(response.status).toBe(201);

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: response.body.data.id },
    });

    expect(row.notifiedAt).toBeNull();
    expect(row.notifyAttempts).toBe(0);
    expect(row.notifyError).toBeNull();
    expect(row.readAt).toBeNull();
    expect(row.respondedAt).toBeNull();
  });

  /**
   * The gate, against the real table rather than a mocked Prisma.
   *
   * This is what proves nothing reaches the Bot API: the outbox refuses to
   * run at all with its destination unconfigured, so it never builds a
   * message and never opens a socket. Checked as a returned empty array AND
   * as an untouched row -- a notifier that queried and then failed to send
   * would leave notifyAttempts at 1, and before the token gate existed it
   * would have burned all three in six minutes.
   */
  it('leaves the outbox inert when neither half of the address is configured', async () => {
    const response = await send({ subject: 'bug', content: 'שום דבר לא נשלח' });
    expect(response.status).toBe(201);

    expect(notifier.isConfigured()).toBe(false);
    await expect(notifier.deliverPending()).resolves.toEqual([]);

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: response.body.data.id },
    });
    expect(row.notifiedAt).toBeNull();
    expect(row.notifyAttempts).toBe(0);
    expect(row.notifyError).toBeNull();
  });

  it('counts only the last hour', async () => {
    for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i += 1) {
      await prisma.feedback.create({
        data: {
          userId: USER,
          subject: 'bug',
          content: `old ${i}`,
          mashovUserId: `mashov-${USER}`,
          username: 'parent-one',
          displayName: 'קורס דמיטרי',
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
    }

    const res = await send({ subject: 'bug', content: 'חדש' });

    expect(res.status).toBe(201);
  });
});
