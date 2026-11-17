-- Local-only fixture for exercising the daily digest by hand.
--
-- The digest reports *today's* school data, so there is nothing to look at
-- unless today's rows exist. A real sync needs Mashov credentials and the
-- residential proxy (ADR-0023), and even then a genuinely quiet school day
-- proves nothing. This seeds one synthetic child whose rows deliberately hit
-- every branch of the report, and the session row needed to reach the
-- manual-run endpoint behind the global AppSessionGuard.
--
-- Re-runnable: it clears its own ledger rows first, so the same items report
-- again on every run. Everything it writes is prefixed `local-digest`, and
-- the teardown at the bottom of docs/ops/digest-local-test.md removes it.
--
--   docker compose exec -T db psql -U postgres -d mashov \
--     -f /dev/stdin < backend/scripts/seed-digest-local.sql
--
-- NEVER run this against production. It inserts a usable session token.

BEGIN;

-- The Jerusalem calendar date at UTC midnight -- which is what the digest
-- means by "today", because Mashov sends naive timestamps and the containers
-- run in UTC (see jerusalemDayBounds in digest-deadline.service.ts).
CREATE TEMPORARY VIEW local_digest_day AS
  SELECT ((now() AT TIME ZONE 'Asia/Jerusalem')::date)::timestamp AS today;

-- Scope the rows to the year the digest will resolve. With no active
-- household connection, currentSchoolYearFor() falls back to the calendar:
-- Sep 2026 - Jun 2027 is year 2027.
CREATE TEMPORARY VIEW local_digest_year AS
  SELECT CASE
           WHEN EXTRACT(MONTH FROM now()) >= 9 THEN EXTRACT(YEAR FROM now()) + 1
           ELSE EXTRACT(YEAR FROM now())
         END::int AS school_year;

-- Start from a clean ledger so the items are unreported again.
DELETE FROM digest_reported_item WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM digest_delivery WHERE "studentGuid" = 'local-digest-guid';

-- The parent, and a session token to authenticate as them.
INSERT INTO app_user (id, "mashovUserId", semel, username, "displayName", "createdAt", "updatedAt")
VALUES ('local-digest-user', 'local-digest-user', 999999, 'local-digest', 'Local Digest Tester', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_session (id, "userId", "sessionToken", "expiresAt", "lastActivityAt", "createdAt")
VALUES (
  'local-digest-session',
  'local-digest-user',
  'local-digest-token',
  now() + interval '30 days',
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE
  SET "expiresAt" = now() + interval '30 days',
      "lastActivityAt" = now(),
      "revokedAt" = NULL;

-- The child. First name only ever reaches the model; the family name is here
-- precisely so the redaction has something to strip.
INSERT INTO student (
  id, "studentGuid", "privateName", "familyName", "fullName",
  "classCode", "classNum", gender, "isActive", "updatedAt"
)
VALUES (
  'local-digest-student', 'local-digest-guid', 'יונתן', 'לוי', 'יונתן לוי',
  'ז', 3, 'M', true, now()
)
ON CONFLICT ("studentGuid") DO UPDATE
  SET "isActive" = true, "updatedAt" = now();

-- Who the digest goes to. The address is a placeholder: a dry run routes
-- every send through LogSender regardless of channel, so nothing leaves the
-- host until you replace this with a real chat id and turn dry run off.
INSERT INTO digest_recipient (
  id, "userId", "studentGuid", channel, address, "displayName",
  enabled, "activeFrom", "createdAt", "updatedAt"
)
SELECT
  'local-digest-recipient', 'local-digest-user', 'local-digest-guid',
  'telegram', '0000000000', 'Local dry run',
  true, today - interval '30 days', now(), now()
FROM local_digest_day
-- Conflict on the id, not on (studentGuid, channel, address): once you point
-- this row at a real chat id the tuple no longer matches, and the insert would
-- fail on the primary key instead. `address` is deliberately left alone here,
-- so re-seeding to clear the ledger cannot silently redirect a real send back
-- to the placeholder.
ON CONFLICT (id) DO UPDATE
  SET enabled = true,
      "activeFrom" = (SELECT today - interval '30 days' FROM local_digest_day),
      "updatedAt" = now();

-- 1. A behaviour event recorded today. `remark` is free text, which is the
--    known limitation in ADR-0025: it reaches the model verbatim.
INSERT INTO behavior_item (
  id, "studentGuid", "lessonId", "groupId", "eventCode", "achvaCode",
  "achvaName", classification, justifiable, "lessonDate", lesson, subject,
  reporter, remark, "eventAt", "schoolYear", "updatedAt"
)
SELECT
  'local-digest-behavior', 'local-digest-guid', 9001, 7001, 1, 1,
  'איחור', 'negative', false, today, 2, 'מתמטיקה',
  'מורה בדיקה', 'הגיע באיחור של עשר דקות לשיעור', now(), school_year, now()
FROM local_digest_day, local_digest_year
ON CONFLICT ("studentGuid", "schoolYear", "lessonId", "eventCode") DO UPDATE
  SET "lessonDate" = (SELECT today FROM local_digest_day),
      "eventAt" = now(),
      "updatedAt" = now();

-- 2. Homework assigned today, with no deadline language at all. This is the
--    plain "newly assigned" case -- it must be reported once and never again.
INSERT INTO homework_item (
  id, "studentGuid", "lessonId", "groupId", "lessonDate", lesson,
  "subjectName", "homeworkText", remark, "schoolYear", "updatedAt"
)
SELECT
  'local-digest-hw-new', 'local-digest-guid', 9101, 7101, today, 3,
  'לשון', 'שאלות 1-5 בעמוד 42', NULL, school_year, now()
FROM local_digest_day, local_digest_year
ON CONFLICT ("studentGuid", "schoolYear", "lessonId") DO UPDATE
  SET "lessonDate" = (SELECT today FROM local_digest_day),
      "homeworkText" = 'שאלות 1-5 בעמוד 42',
      "updatedAt" = now();

-- 3. Homework from five days ago whose Hebrew text names a deadline. Five days
--    puts it outside the 3-day "newly assigned" window and inside the 14-day
--    due window, so it arrives purely as a due-tomorrow candidate -- the path
--    where the model extracts the date and the report labels it צפי הגשה.
INSERT INTO homework_item (
  id, "studentGuid", "lessonId", "groupId", "lessonDate", lesson,
  "subjectName", "homeworkText", remark, "schoolYear", "updatedAt"
)
SELECT
  'local-digest-hw-due', 'local-digest-guid', 9102, 7102,
  today - interval '5 days', 1,
  'היסטוריה', 'להגיש את העבודה על ימי הביניים עד מחר', NULL, school_year, now()
FROM local_digest_day, local_digest_year
ON CONFLICT ("studentGuid", "schoolYear", "lessonId") DO UPDATE
  SET "lessonDate" = (SELECT today - interval '5 days' FROM local_digest_day),
      "homeworkText" = 'להגיש את העבודה על ימי הביניים עד מחר',
      "updatedAt" = now();

-- The timetable row that makes the fallback estimate land on tomorrow, for
-- when the model finds no explicit date. Mashov's weekday base is
-- 1 = Sunday ... 6 = Friday, so tomorrow's `day` is its UTC weekday + 1.
INSERT INTO timetable_entry (
  id, "studentGuid", "groupId", day, lesson, "roomNum", weeks,
  "groupName", "subjectName", "schoolYear", "updatedAt"
)
SELECT
  'local-digest-timetable', 'local-digest-guid', 7102,
  EXTRACT(DOW FROM today + interval '1 day')::int + 1,
  1, '12', -1, 'היסטוריה ז3', 'היסטוריה', school_year, now()
FROM local_digest_day, local_digest_year
ON CONFLICT ("studentGuid", "schoolYear", day, lesson) DO UPDATE
  SET "groupId" = 7102, "updatedAt" = now();

-- 4. An early release the parent filed for tomorrow. Their own remark is here
--    on purpose: the report shows it back to them, and it is the one free-text
--    field that never goes to the model (it names the child).
DELETE FROM student_release WHERE "studentGuid" = 'local-digest-guid';
INSERT INTO student_release (
  id, "studentGuid", "releaseId", "schoolYear", "releaseDate", "startHour",
  remark, status, "isDeleted", "requestEditTime", "updatedAt"
)
SELECT
  'local-digest-release', 'local-digest-guid', 64, school_year,
  today + interval '1 day', '11:30:00',
  'אבקש לשחרר את יונתן מחר ב-11:30, יש לו תור לרופא. תודה',
  1, false, now(), now()
FROM local_digest_day, local_digest_year;

-- 5. A consent form nobody has answered, due in three days. Household-scoped,
--    so it hangs off the user rather than the child.
DELETE FROM school_activity WHERE "userId" = 'local-digest-user';
INSERT INTO school_activity (
  id, "userId", "activityId", "schoolYear", "activityType", title,
  "descriptionText", "activityStartDate", "activityEndDate", "endAnswerDate",
  "isAnswered", "createTime", "updatedAt"
)
SELECT
  'local-digest-activity', 'local-digest-user', 7, school_year, 1,
  'טיול שנתי לגליל התחתון',
  'מכתב ההסכמה המלא, לאחר הסרת ה-HTML.',
  today + interval '8 days', today + interval '9 days', today + interval '3 days',
  false, now(), now()
FROM local_digest_day, local_digest_year;

-- A fresh successful sync for this child, under the per-child source name the
-- sync tasks actually write (`homework:<guid>`). Without it the digest treats
-- a quiet day as a stalled sync and reports skipped_stale instead.
DELETE FROM sync_run WHERE source LIKE '%:local-digest-guid' OR source LIKE '%:local-digest-user';
INSERT INTO sync_run (id, source, status, "startedAt", "endedAt", "fetchedCount", "createdCount", "updatedCount")
VALUES
  ('local-digest-sync-hw', 'homework:local-digest-guid', 'success', now(), now(), 2, 2, 0),
  ('local-digest-sync-beh', 'behavior:local-digest-guid', 'success', now(), now(), 1, 1, 0),
  ('local-digest-sync-rel', 'releases:local-digest-guid', 'success', now(), now(), 1, 1, 0),
  ('local-digest-sync-act', 'schoolActivities:local-digest-user', 'success', now(), now(), 1, 1, 0);

COMMIT;

SELECT
  (SELECT count(*) FROM homework_item WHERE "studentGuid" = 'local-digest-guid') AS homework,
  (SELECT count(*) FROM behavior_item WHERE "studentGuid" = 'local-digest-guid') AS behavior,
  (SELECT count(*) FROM timetable_entry WHERE "studentGuid" = 'local-digest-guid') AS timetable,
  (SELECT count(*) FROM student_release WHERE "studentGuid" = 'local-digest-guid') AS releases,
  (SELECT count(*) FROM school_activity WHERE "userId" = 'local-digest-user') AS activities,
  (SELECT count(*) FROM digest_reported_item WHERE "studentGuid" = 'local-digest-guid') AS already_reported;
