/**
 * Integration tests for the Mashov backend API.
 *
 * Requirements:
 * - DATABASE_URL must point to a real test PostgreSQL database
 * - The database must have Prisma migrations applied before running
 * - MashovHttpClient is mocked — no real upstream HTTP calls
 *
 * Run: DATABASE_URL=postgresql://test:test@localhost:5432/testdb npx jest tests/integration
 */
import { INestApplication, ValidationPipe } from '../../backend/node_modules/@nestjs/common';
import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import request from 'supertest';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { HealthModule } from '../../backend/src/health/health.module';
import { ChildrenModule } from '../../backend/src/children/children.module';
import { MailModule } from '../../backend/src/mail/mail.module';
import { ReadStateModule } from '../../backend/src/read-state/read-state.module';
import { SyncModule } from '../../backend/src/sync/sync.module';
import { SettingsModule } from '../../backend/src/settings/settings.module';
import { PrismaModule } from '../../backend/src/prisma/prisma.module';
import { SessionModule } from '../../backend/src/session/session.module';
import { DashboardModule } from '../../backend/src/dashboard/dashboard.module';
import { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import { HttpExceptionFilter } from '../../backend/src/common/filters/http-exception.filter';

const TEST_STUDENT_GUID = 'test-student-guid-001';

async function seedStudent(prisma: PrismaClient): Promise<void> {
  await prisma.student.upsert({
    where: { studentGuid: TEST_STUDENT_GUID },
    create: {
      studentGuid: TEST_STUDENT_GUID,
      privateName: 'Test',
      familyName: 'Student',
      fullName: 'Test Student',
      classCode: '10A',
      classNum: 10,
      gender: 'M',
      isActive: true,
      rawPayload: {},
    },
    update: {},
  });
}

describe('API Integration Tests', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let mockMashovClient: Partial<MashovHttpClient>;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

    mockMashovClient = {
      get: jest.fn().mockResolvedValue([]),
      put: jest.fn().mockResolvedValue({}),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        SessionModule,
        HealthModule,
        ChildrenModule,
        MailModule,
        ReadStateModule,
        SyncModule,
        SettingsModule,
        DashboardModule,
      ],
    })
      .overrideProvider(MashovHttpClient)
      .useValue(mockMashovClient)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['/health'] });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean test-specific data before each test
    await prisma.readState.deleteMany({});
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: TEST_STUDENT_GUID } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: TEST_STUDENT_GUID } });
    await prisma.mailMessage.deleteMany({});
    await prisma.mailConversation.deleteMany({});
    await prisma.student.deleteMany({ where: { studentGuid: TEST_STUDENT_GUID } });
    await prisma.syncRun.deleteMany({});
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------
  describe('GET /health', () => {
    it('returns 200 with status ok and connected db', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('connected');
    });
  });

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  describe('GET /api/v1/dashboard', () => {
    it('returns contract-aligned fields including feed linkPath and freshness.state', async () => {
      await seedStudent(prisma);

      await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 700,
          groupId: 701,
          lessonDate: new Date('2026-03-12T00:00:00Z'),
          lesson: 2,
          subjectName: 'Math',
          homeworkText: 'Page 10 exercises',
          rawPayload: {},
        },
      });

      await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 710,
          groupId: 711,
          eventCode: 11,
          achvaCode: 11,
          achvaName: 'Late',
          classification: 'attention',
          lessonDate: new Date('2026-03-12T00:00:00Z'),
          lesson: 3,
          subject: 'Math',
          reporter: 'Teacher A',
          eventAt: new Date('2026-03-12T09:00:00Z'),
          rawPayload: {},
        },
      });

      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-dashboard-001',
          subject: 'Message from school',
          senderNamePreview: 'School Office',
          sendTime: new Date('2026-03-12T10:00:00Z'),
          isUnread: true,
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.freshness).toHaveProperty('state');
      expect(res.body.freshness).toHaveProperty('lastSyncAt');
      expect(Array.isArray(res.body.freshness.staleSources)).toBe(true);

      expect(res.body.school).toHaveProperty('schoolName');
      expect(res.body.school).toHaveProperty('schoolYear');
      expect(Array.isArray(res.body.feed)).toBe(true);

      if (res.body.feed.length > 0) {
        expect(res.body.feed[0]).toHaveProperty('sourceId');
        expect(res.body.feed[0]).toHaveProperty('studentGuid');
        expect(res.body.feed[0]).toHaveProperty('studentName');
        expect(res.body.feed[0]).toHaveProperty('eventAt');
        expect(res.body.feed[0]).toHaveProperty('syncedAt');
        expect(typeof res.body.feed[0].linkPath).toBe('string');
        expect(res.body.feed[0].linkPath.length).toBeGreaterThan(0);
      }

      expect(Array.isArray(res.body.children)).toBe(true);
      if (res.body.children.length > 0) {
        expect(res.body.children[0]).toHaveProperty('privateName');
        expect(res.body.children[0]).toHaveProperty('familyName');
        expect(res.body.children[0]).toHaveProperty('recentHomeworkCount');
        expect(res.body.children[0]).toHaveProperty('recentBehaviorCount');
        expect(res.body.children[0]).toHaveProperty('oneLineStatus');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------
  describe('GET /api/v1/children', () => {
    it('returns 200 with empty array when no students exist', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/children');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it('returns 200 with seeded student in the list', async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get('/api/v1/children');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].studentGuid).toBe(TEST_STUDENT_GUID);
    });
  });

  describe('GET /api/v1/children/:studentGuid', () => {
    it('returns 200 with student workspace when student exists', async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.student).toBeDefined();
      expect(res.body.student.studentGuid).toBe(TEST_STUDENT_GUID);
    });

    it('returns 404 when student does not exist', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/children/non-existent-guid-xyz',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/children/:studentGuid/homework', () => {
    it('returns 200 with paginated empty result when no homework exists', async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toMatchObject({
        page: 1,
        total: 0,
        totalPages: 0,
      });
    });

    it('respects page and limit query parameters', async () => {
      await seedStudent(prisma);

      // Seed 3 homework items
      for (let i = 0; i < 3; i++) {
        await prisma.homeworkItem.create({
          data: {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 100 + i,
            groupId: 200,
            lessonDate: new Date(),
            lesson: i + 1,
            subjectName: `Subject ${i}`,
            homeworkText: `Homework ${i}`,
            rawPayload: {},
          },
        });
      }

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework?page=1&limit=2`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(2);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.totalPages).toBe(2);
    });

    it('returns 404 when student does not exist', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/children/non-existent-guid/homework',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/children/:studentGuid/behavior', () => {
    it('returns 200 with paginated empty result when no behavior items exist', async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/behavior`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('returns all items when bucket=all (default)', async () => {
      await seedStudent(prisma);

      await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 300,
          groupId: 400,
          eventCode: 2,
          achvaCode: 2,
          achvaName: 'Absence',
          classification: 'attention',
          lessonDate: new Date(),
          lesson: 1,
          subject: 'Math',
          reporter: 'Teacher A',
          eventAt: new Date(),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/behavior?bucket=all`,
      );
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(1);
    });

    it('returns 404 when student does not exist', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/children/non-existent-guid/behavior',
      );
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Mail
  // ---------------------------------------------------------------------------
  describe('GET /api/v1/mail/conversations', () => {
    it('returns 200 with empty paginated result when no conversations exist', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/mail/conversations');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('filters conversations by unreadOnly=true', async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-unread-001',
          subject: 'Unread message',
          sendTime: new Date(),
          isUnread: true,
          rawPayload: {},
        },
      });
      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-read-001',
          subject: 'Read message',
          sendTime: new Date(),
          isUnread: false,
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/mail/conversations?unreadOnly=true',
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].conversationId).toBe('conv-unread-001');
      expect(res.body.pagination.total).toBe(1);
    });

    it('returns all conversations when unreadOnly is not specified', async () => {
      await prisma.mailConversation.createMany({
        data: [
          {
            conversationId: 'conv-a',
            subject: 'Conv A',
            sendTime: new Date(),
            isUnread: true,
            rawPayload: {},
          },
          {
            conversationId: 'conv-b',
            subject: 'Conv B',
            sendTime: new Date(),
            isUnread: false,
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get('/api/v1/mail/conversations');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(2);
    });
  });

  describe('GET /api/v1/mail/conversations/:id', () => {
    it('returns 200 with conversation when it exists in DB (with messages in DB)', async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-detail-001',
          subject: 'Test conversation',
          sendTime: new Date(),
          rawPayload: {},
        },
      });
      await prisma.mailMessage.create({
        data: {
          messageId: 'msg-001',
          conversationId: 'conv-detail-001',
          senderId: 'sender-1',
          senderName: 'Teacher',
          subject: 'Test conversation',
          bodyHtmlSanitized: '<p>Hello</p>',
          sendTime: new Date(),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/mail/conversations/conv-detail-001',
      );
      expect(res.status).toBe(200);
      expect(res.body.conversation.conversationId).toBe('conv-detail-001');
      expect(res.body.messages).toBeDefined();
    });

    it('returns 404 when conversation does not exist', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/mail/conversations/non-existent-conv-id',
      );
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Read State
  // ---------------------------------------------------------------------------
  describe('POST /api/v1/read-state', () => {
    it('creates a new read state record and returns it', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemType: 'notification', itemId: 'notif-001', isRead: true });

      expect(res.status).toBe(201);
      expect(res.body.itemType).toBe('notification');
      expect(res.body.itemId).toBe('notif-001');
      expect(res.body.isRead).toBe(true);
      expect(res.body.isHandled).toBe(false);
    });

    it('upserts correctly — second call updates existing record', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemType: 'notification', itemId: 'notif-002', isRead: false });

      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemType: 'notification', itemId: 'notif-002', isRead: true, isHandled: true });

      expect(res.status).toBe(201);
      expect(res.body.isRead).toBe(true);
      expect(res.body.isHandled).toBe(true);

      // Verify only one record exists in DB
      const count = await prisma.readState.count({
        where: { itemType: 'notification', itemId: 'notif-002' },
      });
      expect(count).toBe(1);
    });

    it('returns validation error when itemType is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemId: 'notif-003' });

      expect(res.status).toBe(200); // controller returns 200 with error body
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns validation error when itemId is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemType: 'notification' });

      expect(res.status).toBe(200); // controller returns 200 with error body
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------
  describe('POST /api/v1/sync/refresh', () => {
    it('returns 202 with started=true', async () => {
      // The sync triggers background tasks — we just check the response contract
      const res = await request(app.getHttpServer()).post('/api/v1/sync/refresh');
      expect(res.status).toBe(202);
      expect(res.body.started).toBe(true);
      expect(typeof res.body.message).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  describe('GET /api/v1/settings/source-health', () => {
    it('returns 200 with an array (empty when no sync runs exist)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/settings/source-health');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns sync run data when sync runs exist in DB', async () => {
      await prisma.syncRun.create({
        data: {
          source: 'notifications',
          status: 'success',
          startedAt: new Date(),
          endedAt: new Date(),
          fetchedCount: 5,
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/settings/source-health');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      const notificationsEntry = res.body.find(
        (s: { source: string }) => s.source === 'notifications',
      );
      expect(notificationsEntry).toBeDefined();
      expect(notificationsEntry.status).toBe('success');
    });
  });
});
