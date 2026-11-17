-- School-year scoping.
--
-- Every statement here is idempotent, because this file is executed on every
-- container boot by backend/Dockerfile, immediately after `prisma db push` and
-- BEFORE the app starts. That ordering is load-bearing: `db push` adds the
-- columns at 0 and swaps the unique keys in one step, so if the app were
-- allowed to start first its crons would upsert on `(guid, <year>, ...)`,
-- miss the `(guid, 0, ...)` rows, and insert a duplicate of every homework
-- item, behaviour event, subject, timetable slot and notice — which the reads
-- would then show twice, and which would make the UPDATEs below fail on a
-- unique violation, leaving no way back without hand-written dedupe SQL.
--
-- Every column is declared with DEFAULT 0 on purpose: backend/Dockerfile runs
-- `prisma db push --accept-data-loss` on every boot, and adding a required Int
-- with no default to a populated table under that flag can drop and recreate
-- the table. The default makes the add non-destructive; the UPDATE below then
-- stamps the pre-existing rows with 2026, the year they were actually fetched
-- for.
--
-- Production's schema comes from `db push`, not from this file, so
-- backend/scripts/backfill-school-year.ts is what actually runs there. This
-- file exists for repo and CI parity.

-- AlterTable
ALTER TABLE "homework_item" ADD COLUMN IF NOT EXISTS "schoolYear" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "behavior_item" ADD COLUMN IF NOT EXISTS "schoolYear" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subject_enrollment" ADD COLUMN IF NOT EXISTS "schoolYear" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "timetable_entry" ADD COLUMN IF NOT EXISTS "schoolYear" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "message_board_item" ADD COLUMN IF NOT EXISTS "schoolYear" INTEGER NOT NULL DEFAULT 0;

-- Backfill: everything that existed before this migration was fetched for the
-- 2025/26 school year, which Mashov names 2026.
UPDATE "homework_item" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;
UPDATE "behavior_item" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;
UPDATE "subject_enrollment" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;
UPDATE "timetable_entry" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;
UPDATE "message_board_item" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;

-- The unique keys must absorb the year or next year's rows silently overwrite
-- last year's. timetable_entry is the clearest case: the same day and lesson
-- recur every single year.
DROP INDEX IF EXISTS "homework_item_studentGuid_lessonId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "homework_item_studentGuid_schoolYear_lessonId_key"
  ON "homework_item"("studentGuid", "schoolYear", "lessonId");

DROP INDEX IF EXISTS "behavior_item_studentGuid_lessonId_eventCode_key";
CREATE UNIQUE INDEX IF NOT EXISTS "behavior_item_studentGuid_schoolYear_lessonId_eventCode_key"
  ON "behavior_item"("studentGuid", "schoolYear", "lessonId", "eventCode");

DROP INDEX IF EXISTS "subject_enrollment_studentGuid_groupId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "subject_enrollment_studentGuid_schoolYear_groupId_key"
  ON "subject_enrollment"("studentGuid", "schoolYear", "groupId");

DROP INDEX IF EXISTS "timetable_entry_studentGuid_day_lesson_key";
CREATE UNIQUE INDEX IF NOT EXISTS "timetable_entry_studentGuid_schoolYear_day_lesson_key"
  ON "timetable_entry"("studentGuid", "schoolYear", "day", "lesson");

DROP INDEX IF EXISTS "message_board_item_studentGuid_eventId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "message_board_item_studentGuid_schoolYear_eventId_key"
  ON "message_board_item"("studentGuid", "schoolYear", "eventId");

-- Collapse duplicate household connections.
--
-- The connection identity key moved from (schoolCode, schoolYear) to
-- (schoolCode, username): that is what lets an existing connection advance to
-- a new year instead of being stranded on the one it was created with. But the
-- OLD per-year keying is exactly what produced more than one row per
-- (schoolCode, username) in the first place, and with several of them still
-- active the sync tasks and the year-scoped reads can settle on different
-- rows -- so writes land under one year while reads filter on another.
--
-- Deactivating, not deleting: the row still holds the encrypted credentials
-- and the sync history references its id. Keeping the most recently used row
-- per pair makes `active = true` effectively unique without a constraint that
-- `prisma db push` would hard-fail the whole boot on. Idempotent -- a second
-- run finds exactly one active row per pair and changes nothing.
UPDATE "household_connection" AS stale
SET "active" = false
WHERE stale."active" = true
  AND EXISTS (
    SELECT 1
    FROM "household_connection" AS keep
    WHERE keep."schoolCode" = stale."schoolCode"
      AND keep."username" = stale."username"
      AND keep."active" = true
      AND (
        COALESCE(keep."lastLoginAt", keep."updatedAt"),
        keep."updatedAt",
        keep."id"
      ) > (
        COALESCE(stale."lastLoginAt", stale."updatedAt"),
        stale."updatedAt",
        stale."id"
      )
  );
