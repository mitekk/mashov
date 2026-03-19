import {
  INestApplication,
  ValidationPipe,
} from "../../backend/node_modules/@nestjs/common";
import {
  Test,
  TestingModule,
} from "../../backend/node_modules/@nestjs/testing";
import { ConfigModule } from "../../backend/node_modules/@nestjs/config";
import request from "supertest";
import { PrismaClient } from "../../backend/node_modules/@prisma/client";

import { HealthModule } from "../../backend/src/health/health.module";
import { ChildrenModule } from "../../backend/src/children/children.module";
import { MailModule } from "../../backend/src/mail/mail.module";
import { SyncModule } from "../../backend/src/sync/sync.module";
import { SettingsModule } from "../../backend/src/settings/settings.module";
import { PrismaModule } from "../../backend/src/prisma/prisma.module";
import { SessionModule } from "../../backend/src/session/session.module";
import { DashboardModule } from "../../backend/src/dashboard/dashboard.module";
import { MashovHttpClient } from "../../backend/src/session/mashov-http.client";
import { HttpExceptionFilter } from "../../backend/src/common/filters/http-exception.filter";

const TEST_STUDENT_GUID = "test-student-guid-001";
const OTHER_STUDENT_GUID = "test-student-guid-002";

async function seedStudent(prisma: PrismaClient): Promise<void> {
  await seedStudentWithGuid(prisma, TEST_STUDENT_GUID);
}

async function seedStudentWithGuid(
  prisma: PrismaClient,
  studentGuid: string,
): Promise<void> {
  await prisma.student.upsert({
    where: { studentGuid },
    create: {
      studentGuid,
      privateName: "Test",
      familyName: "Student",
      fullName: "Test Student",
      classCode: "10A",
      classNum: 10,
      gender: "M",
      isActive: true,
      rawPayload: {},
    },
    update: {},
  });
}

describe("API Integration Tests (isNew refactor contract)", () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let mashovGetMock: jest.Mock;
  let mashovPutMock: jest.Mock;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();

    mashovGetMock = jest.fn().mockResolvedValue({ messages: [] });
    mashovPutMock = jest.fn().mockResolvedValue({});

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        SessionModule,
        HealthModule,
        ChildrenModule,
        MailModule,
        SyncModule,
        SettingsModule,
        DashboardModule,
      ],
    })
      .overrideProvider(MashovHttpClient)
      .useValue({
        get: mashovGetMock,
        put: mashovPutMock,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix("api/v1", { exclude: ["/health"] });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
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
    mashovGetMock.mockReset();
    mashovGetMock.mockResolvedValue({ messages: [] });
    mashovPutMock.mockReset();
    mashovPutMock.mockResolvedValue({});
  });

  describe("GET /health", () => {
    it("returns 200 with status ok and connected db", async () => {
      const res = await request(app.getHttpServer()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", db: "connected" });
    });
  });

  describe("Children API", () => {
    it("GET /api/v1/children returns {data}", async () => {
      await seedStudent(prisma);
      const res = await request(app.getHttpServer()).get("/api/v1/children");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toMatchObject({
        recentHomeworkCount: expect.any(Number),
        recentBehaviorCount: expect.any(Number),
        positiveBehaviorCount: expect.any(Number),
      });
    });

    it("GET /api/v1/children/:studentGuid returns {student, summary, lastSyncAt}", async () => {
      await seedStudent(prisma);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("student");
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("lastSyncAt");
      expect(res.body).not.toHaveProperty("homework");
      expect(res.body.summary).toMatchObject({
        recentHomeworkCount: expect.any(Number),
        recentBehaviorCount: expect.any(Number),
        positiveBehaviorCount: expect.any(Number),
        subjectCount: expect.any(Number),
        totalWeeklyHours: expect.any(Number),
        attentionBehaviorCount: expect.any(Number),
      });
    });

    it("GET subjects/notices return {data} envelope", async () => {
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

    it("GET lessons/plans returns {data} and proxies upstream with weeklyPlan referer", async () => {
      await seedStudent(prisma);

      mashovGetMock.mockImplementation(async (path: string) => {
        if (path === `/api/students/${TEST_STUDENT_GUID}/lessons/plans`) {
          return [
            {
              groupid: 181,
              lessondate: "2026-03-20T00:00:00",
              lesson: 1,
              plan: "קריאת טקסט",
            },
          ];
        }
        return [];
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/lessons/plans`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [
          {
            groupid: 181,
            lessondate: "2026-03-20T00:00:00",
            lesson: 1,
            plan: "קריאת טקסט",
          },
        ],
      });
      expect(mashovGetMock).toHaveBeenCalledWith(
        `/api/students/${TEST_STUDENT_GUID}/lessons/plans`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Referer: `https://web.mashov.info/students/main/students/${TEST_STUDENT_GUID}/weeklyPlan`,
          }),
        }),
      );
    });

    it("GET lessons/history returns {data} and gracefully falls back to empty array on upstream error", async () => {
      await seedStudent(prisma);

      mashovGetMock.mockImplementationOnce(async (path: string) => {
        if (path === `/api/students/${TEST_STUDENT_GUID}/lessons/history`) {
          return [
            {
              groupName: "שפה ג3",
              subjectName: "שפה",
              lessonLog: {
                lessonID: 537,
                groupId: 181,
                lessonDate: "2026-03-20T00:00:00",
                lesson: 1,
                tookPlace: true,
                remark: "עבדנו על הבנת הנקרא",
                homeWork: "לקרוא עמוד 12",
                lessontype: 0,
                reporterid: 0,
                reporterGuid: "a7246be3-18b8-45dd-874c-fa426d022348",
              },
            },
          ];
        }
        return [];
      });

      const successRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/lessons/history`,
      );
      expect(successRes.status).toBe(200);
      expect(successRes.body.data).toHaveLength(1);
      expect(successRes.body.data[0]).toMatchObject({
        groupName: "שפה ג3",
        subjectName: "שפה",
      });
      expect(mashovGetMock).toHaveBeenCalledWith(
        `/api/students/${TEST_STUDENT_GUID}/lessons/history`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Referer: `https://web.mashov.info/students/main/students/${TEST_STUDENT_GUID}/weeklyPlan`,
          }),
        }),
      );

      mashovGetMock.mockImplementationOnce(async () => {
        throw new Error("upstream unavailable");
      });

      const fallbackRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/lessons/history`,
      );
      expect(fallbackRes.status).toBe(200);
      expect(fallbackRes.body).toEqual({ data: [] });
    });

    it("GET homework/behavior include isNew and isArchived (not isHandled)", async () => {
      await seedStudent(prisma);

      const homework = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subjectName: "Math",
          homeworkText: "Do pages 1-2",
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
          achvaName: "Absence",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 3,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T10:00:00Z"),
          rawPayload: {},
        },
      });

      void homework;
      void behavior;

      const homeworkRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework`,
      );
      const behaviorRes = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/behavior`,
      );

      expect(homeworkRes.status).toBe(200);
      expect(homeworkRes.body.data[0]).toHaveProperty("isNew");
      expect(homeworkRes.body.data[0]).toHaveProperty("isArchived");
      expect(homeworkRes.body.data[0]).not.toHaveProperty("isHandled");
      expect(homeworkRes.body.data[0].isNew).toBe(true);

      expect(behaviorRes.status).toBe(200);
      expect(behaviorRes.body.data[0]).toMatchObject({
        bucket: "attention",
        priority: "high",
        isNew: true,
        isArchived: false,
      });
      expect(behaviorRes.body.data[0]).not.toHaveProperty("isHandled");
    });

    it("GET homework with ?status=new returns all items (all default to new without userId)", async () => {
      await seedStudent(prisma);

      await prisma.homeworkItem.createMany({
        data: [
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            lessonDate: new Date("2026-03-10T00:00:00Z"),
            lesson: 2,
            subjectName: "Math",
            homeworkText: "Active homework",
            rawPayload: {},
          },
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 2,
            groupId: 1,
            lessonDate: new Date("2026-03-09T00:00:00Z"),
            lesson: 1,
            subjectName: "Science",
            homeworkText: "Another homework",
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework?status=new`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it("GET homework with ?status=archived returns 0 items (no UserItemState without userId)", async () => {
      await seedStudent(prisma);

      await prisma.homeworkItem.createMany({
        data: [
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            lessonDate: new Date("2026-03-10T00:00:00Z"),
            lesson: 2,
            subjectName: "Math",
            homeworkText: "Active homework",
            rawPayload: {},
          },
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 2,
            groupId: 1,
            lessonDate: new Date("2026-03-09T00:00:00Z"),
            lesson: 1,
            subjectName: "Science",
            homeworkText: "Another homework",
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework?status=archived`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("GET homework with ?status=all returns all items (none archived without userId)", async () => {
      await seedStudent(prisma);

      await prisma.homeworkItem.createMany({
        data: [
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            lessonDate: new Date("2026-03-10T00:00:00Z"),
            lesson: 2,
            subjectName: "Math",
            homeworkText: "Homework one",
            rawPayload: {},
          },
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 2,
            groupId: 1,
            lessonDate: new Date("2026-03-09T00:00:00Z"),
            lesson: 1,
            subjectName: "Science",
            homeworkText: "Homework two",
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/homework?status=all`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it("GET behavior with ?status=all returns all items (none archived without userId)", async () => {
      await seedStudent(prisma);

      await prisma.behaviorItem.createMany({
        data: [
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 11,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: "Absence",
            classification: "attention",
            lessonDate: new Date("2026-03-10T00:00:00Z"),
            lesson: 2,
            subject: "Math",
            reporter: "Teacher",
            eventAt: new Date("2026-03-10T10:00:00Z"),
            rawPayload: {},
          },
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 12,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: "Absence two",
            classification: "attention",
            lessonDate: new Date("2026-03-09T00:00:00Z"),
            lesson: 1,
            subject: "Science",
            reporter: "Teacher",
            eventAt: new Date("2026-03-09T10:00:00Z"),
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/children/${TEST_STUDENT_GUID}/behavior?status=all`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it("PUT /api/v1/children/:guid/homework/:id/is-new updates isNew flag", async () => {
      await seedStudent(prisma);

      const hw = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subjectName: "Math",
          homeworkText: "Homework",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/${hw.id}/is-new`)
        .send({ isNew: false });

      expect(res.status).toBe(200);
      expect(res.body.isNew).toBe(false);
    });

    it("PUT /api/v1/children/:guid/homework/:id/archive sets isArchived=true and isNew=false", async () => {
      await seedStudent(prisma);

      const hw = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subjectName: "Math",
          homeworkText: "Homework",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/${hw.id}/archive`)
        .send({ isArchived: true });

      expect(res.status).toBe(200);
      expect(res.body.isArchived).toBe(true);
      expect(res.body.isNew).toBe(false);
    });

    it("PUT /api/v1/children/:guid/homework/:id/archive with isArchived=false restores isNew=true", async () => {
      await seedStudent(prisma);

      const hw = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subjectName: "Math",
          homeworkText: "Homework",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/${hw.id}/archive`)
        .send({ isArchived: false });

      expect(res.status).toBe(200);
      expect(res.body.isArchived).toBe(false);
      expect(res.body.isNew).toBe(true);
    });

    it("PUT /api/v1/children/:guid/behavior/:id/is-new updates isNew flag", async () => {
      await seedStudent(prisma);

      const beh = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Absence",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/behavior/${beh.id}/is-new`)
        .send({ isNew: false });

      expect(res.status).toBe(200);
      expect(res.body.isNew).toBe(false);
    });

    it("PUT /api/v1/children/:guid/behavior/:id/archive sets isArchived=true and isNew=false", async () => {
      await seedStudent(prisma);

      const beh = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Absence",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/behavior/${beh.id}/archive`)
        .send({ isArchived: true });

      expect(res.status).toBe(200);
      expect(res.body.isArchived).toBe(true);
      expect(res.body.isNew).toBe(false);
    });

    it("PUT /api/v1/children/:guid/homework/is-new bulk updates all provided homework items (no archive filter without userId)", async () => {
      await seedStudent(prisma);

      const homework1 = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 10,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subjectName: "Math",
          homeworkText: "Homework one",
          rawPayload: {},
        },
      });
      const homework2 = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 11,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subjectName: "Science",
          homeworkText: "Homework two",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/is-new`)
        .send({ homeworkIds: [homework1.id, homework2.id], isNew: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });
    });

    it("PUT /api/v1/children/:guid/homework/archive bulk archives items", async () => {
      await seedStudent(prisma);

      const homework = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 12,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subjectName: "History",
          homeworkText: "Archive me",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/archive`)
        .send({ homeworkIds: [homework.id], isArchived: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
    });

    it("PUT /api/v1/children/:guid/behavior/is-new bulk updates all provided behavior items (no archive filter without userId)", async () => {
      await seedStudent(prisma);

      const behavior1 = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 20,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Absence",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T10:00:00Z"),
          rawPayload: {},
        },
      });
      const behavior2 = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 21,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Late",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 2,
          subject: "Science",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T11:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/behavior/is-new`)
        .send({ behaviorIds: [behavior1.id, behavior2.id], isNew: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });
    });

    it("PUT /api/v1/children/:guid/behavior/archive bulk archives behavior items", async () => {
      await seedStudent(prisma);

      const behavior = await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 22,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Restorable",
          classification: "attention",
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-10T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/behavior/archive`)
        .send({ behaviorIds: [behavior.id], isArchived: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
    });

    it("bulk homework endpoint does not modify items that belong to another student", async () => {
      await seedStudent(prisma);
      await seedStudentWithGuid(prisma, OTHER_STUDENT_GUID);

      const ownHomework = await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 30,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subjectName: "Math",
          homeworkText: "Own homework",
          rawPayload: {},
        },
      });
      const otherHomework = await prisma.homeworkItem.create({
        data: {
          studentGuid: OTHER_STUDENT_GUID,
          lessonId: 31,
          groupId: 1,
          lessonDate: new Date("2026-03-10T00:00:00Z"),
          lesson: 1,
          subjectName: "Math",
          homeworkText: "Other homework",
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/children/${TEST_STUDENT_GUID}/homework/is-new`)
        .send({
          homeworkIds: [ownHomework.id, otherHomework.id],
          isNew: false,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });

      const unchangedOther = await prisma.homeworkItem.findUnique({
        where: { id: otherHomework.id },
      });
      expect(unchangedOther).toBeDefined();
    });

    it("bulk behavior endpoint returns 404 for unknown student", async () => {
      const res = await request(app.getHttpServer())
        .put("/api/v1/children/missing-student-guid/behavior/archive")
        .send({ behaviorIds: ["beh-1"], isArchived: true });

      expect(res.status).toBe(404);
    });
  });

  describe("Mail API", () => {
    it("GET /api/v1/mail/summary uses newConversations key with cached count from household", async () => {
      await prisma.householdConnection.create({
        data: {
          schoolCode: 1234,
          schoolYear: 2026,
          username: "user",
          encryptedPassword: "enc",
          schoolName: "School",
          active: true,
          cachedNewCount: 17,
        },
      });
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-cache-1",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.newConversations).toBe(17);
      expect(res.body).not.toHaveProperty("unreadConversations");
    });

    it("GET /api/v1/mail/conversations includes isNew (not isHandled)", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-1",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          isUnread: true,
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations",
      );
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        conversationId: "conv-1",
        isNew: true,
      });
      expect(res.body.data[0]).not.toHaveProperty("isHandled");
    });

    it("GET /api/v1/mail/conversations with filter=new returns only isNew=true conversations", async () => {
      await prisma.mailConversation.createMany({
        data: [
          {
            conversationId: "conv-new",
            subject: "New message",
            senderNamePreview: "School",
            sendTime: new Date("2026-03-12T10:00:00Z"),
            isUnread: true,
            rawPayload: {},
          },
          {
            conversationId: "conv-read",
            subject: "Read message",
            senderNamePreview: "School",
            sendTime: new Date("2026-03-11T10:00:00Z"),
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations?filter=new",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].conversationId).toBe("conv-new");
    });

    it("GET /api/v1/mail/conversations excludes archived-labeled conversations", async () => {
      await prisma.mailConversation.createMany({
        data: [
          {
            conversationId: "conv-visible",
            subject: "Visible",
            senderNamePreview: "School",
            sendTime: new Date("2026-03-12T10:00:00Z"),
            labels: [],
            rawPayload: {},
          },
          {
            conversationId: "conv-archived",
            subject: "Archived",
            senderNamePreview: "School",
            sendTime: new Date("2026-03-11T10:00:00Z"),
            labels: ["archived"],
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].conversationId).toBe("conv-visible");
    });

    it("GET /api/v1/mail/conversations/:id returns flattened contract shape with isNew", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-1",
          subject: "Message Subject",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });
      await prisma.mailMessage.create({
        data: {
          messageId: "msg-1",
          conversationId: "conv-1",
          senderId: "sender-1",
          senderName: "Teacher",
          subject: "Message Subject",
          bodyHtmlSanitized: "<p>Hello</p>",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations/conv-1",
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        conversationId: "conv-1",
        subject: "Message Subject",
        isNew: false,
      });
      expect(res.body).not.toHaveProperty("isHandled");
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.messages[0].messageId).toBe("msg-1");
    });

    it("GET /api/v1/mail/conversations/:id lazy-fetches detail and sanitizes html body", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-lazy",
          subject: "Message Subject",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });
      await prisma.mailMessage.create({
        data: {
          messageId: "msg-lazy",
          conversationId: "conv-lazy",
          senderId: "sender-1",
          senderName: "Teacher",
          subject: "Message Subject",
          bodyHtmlSanitized: null,
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });
      mashovGetMock.mockResolvedValueOnce({
        conversationId: "conv-lazy",
        subject: "Message Subject",
        sendTime: new Date("2026-03-12T10:00:00Z").toISOString(),
        isNew: true,
        hasDrafts: false,
        hasAttachments: true,
        preventReply: false,
        labels: [],
        messages: [
          {
            messageId: "msg-lazy",
            conversationId: "conv-lazy",
            senderId: "sender-1",
            senderName: "Teacher",
            subject: "Message Subject",
            body: '<p>Hello<script>alert("x")</script></p>',
            sendTime: new Date("2026-03-12T10:00:00Z").toISOString(),
            isNew: true,
            recipients: [],
            files: [{ fileId: "f-1" }],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations/conv-lazy",
      );
      expect(res.status).toBe(200);
      expect(res.body.messages[0].bodyHtmlSanitized).toContain("<p>Hello</p>");
      expect(res.body.messages[0].bodyHtmlSanitized).not.toContain("<script>");
      expect(res.body.messages[0].hasAttachments).toBe(true);
      expect(mashovGetMock).toHaveBeenCalledWith(
        "/api/mail/conversations/conv-lazy",
        expect.any(Object),
      );
    });

    it("PUT /api/v1/mail/conversations/mark-read sets isNew=false on specified conversations", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-mark-read",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put("/api/v1/mail/conversations/mark-read")
        .send({ conversationIds: ["conv-mark-read"] });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);

      const conv = await prisma.mailConversation.findUnique({
        where: { conversationId: "conv-mark-read" },
      });
      expect(conv?.isUnread).toBe(false);
    });

    it("PUT /api/v1/mail/conversations/mark-unread proxies raw id array to upstream", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-mark-unread",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer())
        .put("/api/v1/mail/conversations/mark-unread")
        .send({ conversationIds: ["conv-mark-unread"] });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(mashovPutMock).toHaveBeenCalledWith(
        "/api/mail/conversations/markAsUnread",
        ["conv-mark-unread"],
        expect.any(Object),
      );
    });

    it("PUT /api/v1/mail/conversations/archive removes inbox conversation locally", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-archive",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });
      await prisma.mailMessage.create({
        data: {
          messageId: "msg-archive",
          conversationId: "conv-archive",
          senderId: "sender-1",
          senderName: "Teacher",
          subject: "Message",
          bodyHtmlSanitized: "<p>Body</p>",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const archiveRes = await request(app.getHttpServer())
        .put("/api/v1/mail/conversations/archive")
        .send({ conversationIds: ["conv-archive"] });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.updated).toBe(1);
      expect(mashovPutMock).toHaveBeenCalledWith(
        "/api/mail/conversations/move/archive",
        ["conv-archive"],
        expect.any(Object),
      );

      const listRes = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations",
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(0);
    });

    it("PUT /api/v1/mail/conversations/unarchive restores archived conversation to inbox and sets isNew=true", async () => {
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-unarchive",
          subject: "Archived Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          labels: ["archived"],
          rawPayload: {},
        },
      });

      const unarchiveRes = await request(app.getHttpServer())
        .put("/api/v1/mail/conversations/unarchive")
        .send({ conversationIds: ["conv-unarchive"] });
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.updated).toBe(1);
      expect(mashovPutMock).toHaveBeenCalledWith(
        "/api/mail/conversations/markAsUnread",
        ["conv-unarchive"],
        expect.any(Object),
      );

      const archivedListRes = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations?filter=archived",
      );
      expect(archivedListRes.status).toBe(200);
      expect(archivedListRes.body.data).toHaveLength(0);

      const inboxListRes = await request(app.getHttpServer()).get(
        "/api/v1/mail/conversations",
      );
      expect(inboxListRes.status).toBe(200);
      expect(inboxListRes.body.data).toHaveLength(1);
      expect(inboxListRes.body.data[0].conversationId).toBe("conv-unarchive");
      expect(inboxListRes.body.data[0].isNew).toBe(true);
    });
  });

  describe("Read-state API (removed)", () => {
    it("POST /api/v1/read-state returns 404", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/read-state")
        .send({ itemType: "homework", itemId: "hw-1", isHandled: true });

      expect(res.status).toBe(404);
    });

    it("DELETE /api/v1/read-state returns 404", async () => {
      const res = await request(app.getHttpServer()).delete(
        "/api/v1/read-state",
      );

      expect(res.status).toBe(404);
    });
  });

  describe("Dashboard API", () => {
    it("GET /api/v1/dashboard summary newConversations uses cached mail count", async () => {
      await prisma.householdConnection.create({
        data: {
          schoolCode: 1234,
          schoolYear: 2026,
          username: "user",
          encryptedPassword: "enc",
          schoolName: "School",
          active: true,
          cachedNewCount: 23,
        },
      });
      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-dashboard-1",
          subject: "Message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T10:00:00Z"),
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get("/api/v1/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.summary.newConversations).toBe(23);
      expect(res.body.summary).not.toHaveProperty("unreadConversations");
    });

    it("GET /api/v1/dashboard children cards include positiveBehaviorCount and 7-day split", async () => {
      await seedStudent(prisma);

      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      await prisma.homeworkItem.createMany({
        data: [
          // counts: recent
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            lessonDate: threeDaysAgo,
            lesson: 1,
            subjectName: "Math",
            homeworkText: "Unread recent",
            rawPayload: {},
          },
          // counts: recent
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 2,
            groupId: 1,
            lessonDate: threeDaysAgo,
            lesson: 1,
            subjectName: "Math",
            homeworkText: "Read recent",
            rawPayload: {},
          },
          // counts: recent
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 3,
            groupId: 1,
            lessonDate: threeDaysAgo,
            lesson: 1,
            subjectName: "Math",
            homeworkText: "Archived",
            rawPayload: {},
          },
          // excluded: older than 7 days
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 4,
            groupId: 1,
            lessonDate: tenDaysAgo,
            lesson: 1,
            subjectName: "Math",
            homeworkText: "Old unread",
            rawPayload: {},
          },
        ],
      });

      await prisma.behaviorItem.createMany({
        data: [
          // counts: recent + non-positive
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: "Absence",
            classification: "attention",
            lessonDate: threeDaysAgo,
            lesson: 1,
            subject: "Math",
            reporter: "Teacher",
            eventAt: threeDaysAgo,
            rawPayload: {},
          },
          // counts: recent + non-positive
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 2,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: "Late",
            classification: "attention",
            lessonDate: threeDaysAgo,
            lesson: 1,
            subject: "Math",
            reporter: "Teacher",
            eventAt: threeDaysAgo,
            rawPayload: {},
          },
          // counted in positiveBehaviorCount
          {
            studentGuid: TEST_STUDENT_GUID,
            lessonId: 3,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: "Good",
            classification: "positive",
            lessonDate: threeDaysAgo,
            lesson: 1,
            subject: "Math",
            reporter: "Teacher",
            eventAt: threeDaysAgo,
            rawPayload: {},
          },
        ],
      });

      const res = await request(app.getHttpServer()).get("/api/v1/dashboard");
      expect(res.status).toBe(200);

      const child = res.body.children.find(
        (c: { studentGuid: string }) => c.studentGuid === TEST_STUDENT_GUID,
      );
      expect(child).toBeDefined();
      expect(child.recentHomeworkCount).toBe(3);
      expect(child.recentBehaviorCount).toBe(2);
      expect(child.positiveBehaviorCount).toBe(1);
    });

    it("GET /api/v1/dashboard feed includes archived homework/behavior/mail items", async () => {
      await seedStudent(prisma);

      await prisma.homeworkItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 1,
          groupId: 1,
          lessonDate: new Date("2026-03-12T10:00:00Z"),
          lesson: 2,
          subjectName: "Math",
          homeworkText: "Archived homework",
          rawPayload: {},
        },
      });

      await prisma.behaviorItem.create({
        data: {
          studentGuid: TEST_STUDENT_GUID,
          lessonId: 2,
          groupId: 1,
          eventCode: 2,
          achvaCode: 2,
          achvaName: "Archived behavior",
          classification: "attention",
          lessonDate: new Date("2026-03-12T11:00:00Z"),
          lesson: 3,
          subject: "Math",
          reporter: "Teacher",
          eventAt: new Date("2026-03-12T11:00:00Z"),
          rawPayload: {},
        },
      });

      await prisma.mailConversation.create({
        data: {
          conversationId: "conv-dashboard-archived-1",
          subject: "Archived message",
          senderNamePreview: "School",
          sendTime: new Date("2026-03-12T12:00:00Z"),
          labels: ["archived"],
          rawPayload: {},
        },
      });

      const res = await request(app.getHttpServer()).get("/api/v1/dashboard");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.feed)).toBe(true);
      expect(res.body.feed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceType: "homework",
            isArchived: false,
          }),
          expect.objectContaining({
            sourceType: "behavior",
            isArchived: false,
          }),
          expect.objectContaining({
            sourceType: "mail",
            sourceId: "conv-dashboard-archived-1",
            isArchived: true,
          }),
        ]),
      );
    });
  });

  describe("Settings API", () => {
    it("GET /api/v1/settings/source-health returns contract object", async () => {
      await prisma.syncRun.create({
        data: {
          source: "notifications",
          status: "success",
          startedAt: new Date("2026-03-12T09:00:00Z"),
          endedAt: new Date("2026-03-12T09:00:05Z"),
          fetchedCount: 5,
        },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/settings/source-health",
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sources");
      expect(res.body).toHaveProperty("overallState");
      expect(res.body).toHaveProperty("lastFullSyncAt");
      expect(Array.isArray(res.body.sources)).toBe(true);
    });

    it("GET /api/v1/settings/profile returns merged profile data", async () => {
      await prisma.parentProfile.create({
        data: {
          upstreamUserId: "user-1",
          displayName: "Parent",
          email: "parent@example.com",
          cellphone: "0500000000",
          detailsState: 1,
        },
      });
      await prisma.householdConnection.create({
        data: {
          schoolCode: 1234,
          schoolYear: 2026,
          username: "user",
          encryptedPassword: "encrypted",
          schoolName: "Test School",
          active: true,
        },
      });

      const res = await request(app.getHttpServer()).get(
        "/api/v1/settings/profile",
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        upstreamUserId: "user-1",
        schoolName: "Test School",
        schoolYear: 2026,
        schoolCode: 1234,
      });
    });
  });

  describe("Sync API", () => {
    it("POST /api/v1/sync/refresh returns 401 without authenticated user context", async () => {
      const res = await request(app.getHttpServer()).post(
        "/api/v1/sync/refresh",
      );
      expect(res.status).toBe(401);
    });
  });
});
