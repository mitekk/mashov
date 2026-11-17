-- Releases and school activities, for the daily digest.
--
-- Additive only, and safe under the `prisma db push --accept-data-loss` that
-- the Dockerfile runs on every boot (ADR-0024 explains why that is the real
-- migration path here): two new tables, no change to any existing one.

CREATE TABLE "student_release" (
    "id" TEXT NOT NULL,
    "studentGuid" TEXT NOT NULL,
    "releaseId" INTEGER NOT NULL,
    "schoolYear" INTEGER NOT NULL DEFAULT 0,
    "releaseDate" TIMESTAMP(3) NOT NULL,
    "startHour" TEXT NOT NULL,
    "remark" TEXT,
    "status" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "requestEditTime" TIMESTAMP(3),
    "rawPayload" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_release_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_release_studentGuid_schoolYear_releaseId_key"
    ON "student_release"("studentGuid", "schoolYear", "releaseId");

CREATE INDEX "student_release_studentGuid_releaseDate_idx"
    ON "student_release"("studentGuid", "releaseDate");

CREATE TABLE "school_activity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityId" INTEGER NOT NULL,
    "schoolYear" INTEGER NOT NULL DEFAULT 0,
    "activityType" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "descriptionText" TEXT,
    "activityStartDate" TIMESTAMP(3) NOT NULL,
    "activityEndDate" TIMESTAMP(3) NOT NULL,
    "endAnswerDate" TIMESTAMP(3) NOT NULL,
    "isAnswered" BOOLEAN NOT NULL DEFAULT false,
    "createTime" TIMESTAMP(3),
    "rawPayload" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_activity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "school_activity_userId_schoolYear_activityId_key"
    ON "school_activity"("userId", "schoolYear", "activityId");

CREATE INDEX "school_activity_userId_endAnswerDate_idx"
    ON "school_activity"("userId", "endAnswerDate");
