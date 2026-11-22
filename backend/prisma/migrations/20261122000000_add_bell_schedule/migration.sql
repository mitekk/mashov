-- The school's bell schedule: when each lesson period starts and ends.
--
-- Keyed by (schoolCode, schoolYear, lesson) rather than by student, because
-- `GET /api/bells` is school-wide -- it takes no student guid (ADR-0037).
--
-- Times are TEXT "HH:MM", not TIMESTAMP: a bell time is a wall clock reading
-- with no date and no zone, and a timestamp column is how 08:15 becomes 06:15.
--
-- Every statement here is idempotent, because backend/Dockerfile executes this
-- file on every container boot, immediately after `prisma db push`. There is no
-- backfill: a school with no rows reads as "no schedule from the school", and
-- the read path answers from the bundled default instead.
CREATE TABLE IF NOT EXISTS "bell_schedule" (
  "id"         TEXT NOT NULL,
  "schoolCode" INTEGER NOT NULL,
  "schoolYear" INTEGER NOT NULL,
  "lesson"     INTEGER NOT NULL,
  "startTime"  TEXT NOT NULL,
  "endTime"    TEXT NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bell_schedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "bell_schedule_schoolCode_schoolYear_lesson_key"
  ON "bell_schedule" ("schoolCode", "schoolYear", "lesson");
