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

describe('API Integration Tests (Phase 1 contract)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

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
      .useValue({
        get: jest.fn().mockResolvedValue({ messages: [] }),
        put: jest.fn().mockResolvedValue({}),
      })
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
    await prisma.readState.deleteMany({});
    await prisma.mailMessage.deleteMany({});
    await prisma.mailConversation.deleteMany({});
    await prisma.homeworkItem.deleteMany({});
    await prisma.behaviorItem.deleteMany({});
    await prisma.subjectEnrollment.deleteMany({});
    await prisma.messageBoardItem.deleteMany({});
    await prisma.syncRun.deleteMany({});
    await prisma.parentProfile.deleteMany({});
    await prisma.householdConnection.deleteMany({});
    await prisma.student.deleteMany({});
  });

  describe('GET /health', () => {
    it('returns 200 with status ok and connected db', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', db: 'connected' });
    });
  });

  describe('Children API', () => {
    it('GET /api/v1/children returns {data}', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/children');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/v1/children/:studentGuid returns {student, summary, lastSyncAt}', async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('student');
      expect(res.body).toHaveProperty('summary');
      expect(res.body).toHaveProperty('lastSyncAt');
      expect(res.body).not.toHaveProperty('homework');
      expect(res.body.summary).toMatchObject({
        recentHomeworkCount: expect.any(Number),
        recentBehaviorCount: expect.any(Number),
        subjectCount: expect.any(Number),
        totalWeeklyHours: expect.any(Number),
        attentionBehaviorCount: expect.any(Number),
      });
    });

    it('GET subjects/notices return {data} envelope', async () => {
      await seedStudent(prisma);

      const subjectsRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/subjects`,
      );
      const noticesRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/notices`,
      );

      expect(subjectsRes.status).toBe(200);
      expect(Array.isArray(subjectsRes.body.data)).toBe(true);
      expect(noticesRes.status).toBe(200);
      expect(Array.isArray(noticesRes.body.data)).toBe(true);
    });

    it('GET homework/behavior include isHandled and behavior bucket/priority', async () => {
      await seedStudent(prisma);

      const homework = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date('2026-03-10T00:00:00Z'),
          lesson: 2,
          subjectName: 'Math',
          homeworkText: 'Do pages 1-2',
          rawPayload: {},
        },
      });

      const behavior = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 2,
          groupId: 2,
          eventCode: 2,
          achvaCode: 2,
          achvaName: 'Absence',
          classification: 'attention',
          lessonDate: new Date('2026-03-10T00:00:00Z'),
          lesson: 3,
          subject: 'Math',
          reporter: 'Teacher',
          eventAt: new Date('2026-03-10T10:00:00Z'),
          rawPayload: {},
        },
      });

      await prisma.readState.createMany({
        data: [
          {
            itemType: 'homework',
            itemId: homework.id,
            scopeType: 'household',
            scopeId: 'default',
            isHandled: true,
          },
          {
            itemType: 'behavior',
            itemId: behavior.id,
            scopeType: 'household',
            scopeId: 'default',
            isHandled: true,
          },
        ],
      });

      const homeworkRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework`,
      );
      const behaviorRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/behavior`,
      );

      expect(homeworkRes.status).toBe(200);
      expect(homeworkRes.body.data[0].isHandled).toBe(true);
      expect(behaviorRes.status).toBe(200);
      expect(behaviorRes.body.data[0]).toMatchObject({
        bucket: 'attention',
        priority: 'high',
        isHandled: true,
      });
    });
  });

  describe('Mail API', () => {
    it('GET /api/v1/mail/conversations includes isHandled', async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-1',
          subject: 'Message',
          senderNamePreview: 'School',
          sendTime: new Date('2026-03-12T10:00:00Z'),
          isUnread: true,
          rawPayload: {},
        },
      });
      await prisma.readState.create({
        data: {
          itemType: 'mail_conversation',
          itemId: 'conv-1',
          scopeType: 'household',
          scopeId: 'default',
          isHandled: true,
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/mail/conversations');
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        conversationId: 'conv-1',
        isHandled: true,
      });
    });

    it('GET /api/v1/mail/conversations/:id returns flattened contract shape', async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: 'conv-1',
          subject: 'Message Subject',
          senderNamePreview: 'School',
          sendTime: new Date('2026-03-12T10:00:00Z'),
          isUnread: true,
          rawPayload: {},
        },
      });
      await prisma.mailMessage.create({
        data: {
          messageId: 'msg-1',
          conversationId: 'conv-1',
          senderId: 'sender-1',
          senderName: 'Teacher',
          subject: 'Message Subject',
          bodyHtmlSanitized: '<p>Hello</p>',
          sendTime: new Date('2026-03-12T10:00:00Z'),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/mail/conversations/conv-1');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        conversationId: 'conv-1',
        subject: 'Message Subject',
      });
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.messages[0].messageId).toBe('msg-1');
    });
  });

  describe('Settings API', () => {
    it('GET /api/v1/settings/source-health returns contract object', async () => {
      await prisma.syncRun.create({
        data: {
          source: 'notifications',
          status: 'success',
          startedAt: new Date('2026-03-12T09:00:00Z'),
          endedAt: new Date('2026-03-12T09:00:05Z'),
          fetchedCount: 5,
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/settings/source-health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sources');
      expect(res.body).toHaveProperty('overallState');
      expect(res.body).toHaveProperty('lastFullSyncAt');
      expect(Array.isArray(res.body.sources)).toBe(true);
    });

    it('GET /api/v1/settings/profile returns merged profile data', async () => {
      await prisma.parentProfile.create({
        data: {
          upstreamUserId: 'user-1',
          displayName: 'Parent',
          email: 'parent@example.com',
          cellphone: '0500000000',
          detailsState: 1,
        },
      });
      await prisma.householdConnection.create({
        data: {
          schoolCode: 1234,
          schoolYear: 2026,
          username: 'user',
          encryptedPassword: 'encrypted',
          schoolName: 'Test School',
          active: true,
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/settings/profile');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        upstreamUserId: 'user-1',
        schoolName: 'Test School',
        schoolYear: 2026,
        schoolCode: 1234,
      });
    });
  });

  describe('Read-state API', () => {
    it('POST /api/v1/read-state upserts state', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemType: 'feed_item', itemId: 'item-1', isRead: true, isHandled: false });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        itemType: 'feed_item',
        itemId: 'item-1',
        isRead: true,
      });
    });

    it('POST /api/v1/read-state returns 400 on missing required fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ itemId: 'item-1' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/v1/read-state clearAll=true clears read state', async () => {
      await prisma.readState.create({
        data: {
          itemType: 'feed_item',
          itemId: 'item-1',
          scopeType: 'household',
          scopeId: 'default',
          isRead: true,
          isHandled: true,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/read-state')
        .send({ clearAll: true });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ deleted: 1 });
    });
  });

  describe('Sync API', () => {
    it('POST /api/v1/sync/refresh returns 202', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/sync/refresh');
      expect(res.status).toBe(202);
      expect(res.body.started).toBe(true);
      expect(typeof res.body.message).toBe('string');
    });
  });
});
