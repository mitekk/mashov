-- Fold the owning connection into the keys a second school collides on.
--
-- Mashov's numeric ids are per-school counters; only its UUIDs are global. So
-- mail_conversation.conversationId and mail_message.messageId are safe and stay
-- unique on their own (MailMessage.conversation is a relation onto the former),
-- but a notification id, a consent-activity id and a behaviour code are not.
-- Verified against the captured payloads in apis/: school_activity.activityId is
-- literally 1, and get-api-achvas.md carries teacherId and commonBehaveId, which
-- is what makes the behaviour taxonomy school-local rather than global.
--
-- Shipped with the code that adapts the four upsert where-clauses, not with the
-- additive columns: swapping a unique key is not inert, it is a compile-time
-- break at every call site that used the old one.
--
-- The two long composite names are pinned rather than generated: Prisma's own
-- names for them are 67 and 70 characters, past Postgres's 63-byte identifier
-- limit, so they would be silently truncated and `db push` would drift from
-- this file. digest_reported_item_dedup_key documents the same trap.
--
-- Executed on every container boot by backend/Dockerfile after `prisma db push`.
-- Push already performs these swaps from schema.prisma, so this file is parity
-- for `migrate deploy` and CI and a no-op in production.

-- notification_event: a per-school counter. One school's notification silently
-- replaced the other's. NULLs are distinct in a Postgres unique index, so the
-- not-yet-stamped rows the ownership backfill could not attribute do not
-- collide with each other while they wait to be re-stamped.
DROP INDEX IF EXISTS "notification_event_upstreamNotificationId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "notification_event_connection_upstream_id_key"
  ON "notification_event"("householdConnectionId", "upstreamNotificationId");

-- behavior_type_reference: a school's own taxonomy, including its own policy on
-- which absences are justifiable. With one row per code,
-- BehaviorClassifierService answered "is this absence justifiable" from
-- whichever school happened to sync last.
DROP INDEX IF EXISTS "behavior_type_reference_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "behavior_type_reference_schoolCode_code_key"
  ON "behavior_type_reference"("schoolCode", "code");

-- school_activity: userId is the merged household now, so without the
-- connection in the key one school's consent request overwrites the other's --
-- and the digest reports consent deadlines, so the parent would simply never be
-- told about one of them.
DROP INDEX IF EXISTS "school_activity_userId_schoolYear_activityId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "school_activity_user_connection_year_activity_key"
  ON "school_activity"("userId", "householdConnectionId", "schoolYear", "activityId");
