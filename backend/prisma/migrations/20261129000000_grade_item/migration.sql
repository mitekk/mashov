-- Graded assessments: one row per grading event per child, current school year.
--
-- Production's schema comes from `prisma db push --accept-data-loss` on every
-- boot, so this file is the committed record rather than the thing that runs.
-- Every statement here is DDL and every one applies for free under that flag:
-- a new table, its unique key and its one index. There is no data statement,
-- so boot does not need to execute it (see src/prisma/boot-migrations.spec.ts).
--
-- `rate`/`gradeRate` from upstream are not columns: both are 0.0 in every
-- observed row, so there is nothing to weight. See `model GradeItem`.

CREATE TABLE IF NOT EXISTS "grade_item" (
  "id"             TEXT NOT NULL,
  "studentGuid"    TEXT NOT NULL,
  "gradingEventId" INTEGER NOT NULL,
  "grade"          INTEGER NOT NULL,
  "gradingPeriod"  INTEGER NOT NULL,
  "gradeTypeId"    INTEGER NOT NULL,
  "gradeType"      TEXT NOT NULL,
  "gradingEvent"   TEXT NOT NULL,
  "groupId"        INTEGER NOT NULL,
  "groupName"      TEXT NOT NULL,
  "subjectName"    TEXT NOT NULL,
  "teacherName"    TEXT NOT NULL,
  "eventDate"      TIMESTAMP(3) NOT NULL,
  "enteredAt"      TIMESTAMP(3) NOT NULL,
  "rawPayload"     JSONB,
  "schoolYear"     INTEGER NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "grade_item_pkey" PRIMARY KEY ("id")
);

-- The sync task's upsert key.
CREATE UNIQUE INDEX IF NOT EXISTS "grade_item_studentGuid_schoolYear_gradingEventId_key"
  ON "grade_item" ("studentGuid", "schoolYear", "gradingEventId");

-- The only read: one child's year, newest assessment first.
CREATE INDEX IF NOT EXISTS "grade_item_studentGuid_schoolYear_eventDate_idx"
  ON "grade_item" ("studentGuid", "schoolYear", "eventDate");
