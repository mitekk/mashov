-- The household ownership discriminator.
--
-- Every per-school table gains `householdConnectionId`, and the behaviour
-- taxonomy gains `schoolCode`. Until now `Student` had no owner column at all,
-- so `ChildrenService.getChildren()` returned every active child in the
-- database and `MailInboxTask` could not tell one household's mail from
-- another's -- which is why its reconciliation sweep refused to run above one
-- active connection.
--
-- Executed on every container boot by backend/Dockerfile, immediately after
-- `prisma db push` and BEFORE the app starts, because production's schema comes
-- from push and push runs no data statements. Every statement is idempotent.
--
-- Nullable on purpose and permanently: the shared env-credential session
-- legitimately writes unowned rows, NULL means "ownership unknown, re-stamp on
-- the next roster refresh", and a required column cannot be added to the
-- populated production tables at all. Declared with no DEFAULT because TEXT
-- adds as NULL without rewriting the table.

-- AlterTable
ALTER TABLE "student" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
ALTER TABLE "mail_conversation" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
ALTER TABLE "mail_message" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
ALTER TABLE "notification_event" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
ALTER TABLE "school_activity" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
ALTER TABLE "parent_profile" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;

-- DEFAULT 0, like every column 20261117000000 added: adding a NOT NULL INTEGER
-- with no default to a populated table under `db push --accept-data-loss` can
-- drop and recreate it.
ALTER TABLE "behavior_type_reference" ADD COLUMN IF NOT EXISTS "schoolCode" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: the audit trail for linking, and the merge pointer. Nullable, so
-- additive.
ALTER TABLE "household_connection" ADD COLUMN IF NOT EXISTS "linkedByUserId" TEXT;
ALTER TABLE "household_connection" ADD COLUMN IF NOT EXISTS "linkedAt" TIMESTAMP(3);
ALTER TABLE "household_connection" ADD COLUMN IF NOT EXISTS "displayLabel" TEXT;
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mergedIntoUserId" TEXT;

-- CreateIndex: every scoped read leads with householdConnectionId, and none of
-- the existing indexes does, so without these Postgres sequentially scans.
CREATE INDEX IF NOT EXISTS "student_householdConnectionId_isActive_idx"
  ON "student"("householdConnectionId", "isActive");
CREATE INDEX IF NOT EXISTS "mail_conversation_householdConnectionId_isUnread_idx"
  ON "mail_conversation"("householdConnectionId", "isUnread");
CREATE INDEX IF NOT EXISTS "mail_conversation_householdConnectionId_sendTime_idx"
  ON "mail_conversation"("householdConnectionId", "sendTime");
CREATE INDEX IF NOT EXISTS "mail_message_householdConnectionId_idx"
  ON "mail_message"("householdConnectionId");
CREATE INDEX IF NOT EXISTS "notification_event_householdConnectionId_idx"
  ON "notification_event"("householdConnectionId");
CREATE INDEX IF NOT EXISTS "school_activity_householdConnectionId_idx"
  ON "school_activity"("householdConnectionId");
CREATE INDEX IF NOT EXISTS "parent_profile_householdConnectionId_idx"
  ON "parent_profile"("householdConnectionId");

-- Backfill: stamp the rows that already exist.
--
-- Guarded to refuse rather than guess. With two or more active connections
-- there is no way to know which owns a given row, and a wrong guess attributes
-- one school's mail and children to the other permanently -- far worse than
-- leaving NULL, which every upsert's `update` branch re-stamps within one sync
-- cycle anyway. RAISE NOTICE rather than RAISE EXCEPTION so a multi-school
-- deployment still boots.
DO $$
DECLARE
  keeper_id TEXT;
  keeper_semel INTEGER;
  active_count INTEGER;
BEGIN
  SELECT count(*) INTO active_count FROM "household_connection" WHERE "active";

  IF active_count <> 1 THEN
    RAISE NOTICE 'Skipping ownership backfill: % active connections (expected 1)', active_count;
    RETURN;
  END IF;

  SELECT id, "schoolCode" INTO keeper_id, keeper_semel
  FROM "household_connection"
  WHERE "active"
  LIMIT 1;

  UPDATE "student"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  UPDATE "mail_conversation"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  UPDATE "mail_message"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  UPDATE "notification_event"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  UPDATE "school_activity"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  UPDATE "parent_profile"
  SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;

  UPDATE "behavior_type_reference"
  SET "schoolCode" = keeper_semel WHERE "schoolCode" = 0;

  RAISE NOTICE 'Stamped existing rows with connection % (semel %)', keeper_id, keeper_semel;
END $$;
