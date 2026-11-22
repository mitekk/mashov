-- Message board notices: when we first saw one.
--
-- Mashov's payload carries no creation date, and `updatedAt` is churned by the
-- 06:00 upsert, so neither can mean "new". `firstSeenAt` can, but only once
-- the rows already in the table carry an honest value.
--
-- `prisma db push` adds the column with DEFAULT now(), which Postgres writes
-- into every existing row -- so on the deploy that adds it, the whole current
-- board looks first-seen at that instant and the next digest run would
-- announce all of it at once. The UPDATE below is what prevents that, and it
-- is why this file is in the Dockerfile's boot chain: push applies DDL and
-- silently skips every data statement (see src/prisma/boot-migrations.spec.ts).
--
-- Idempotent: it only rewrites rows whose firstSeenAt is still later than
-- their updatedAt, which a genuinely new row never is.

ALTER TABLE "message_board_item"
  ADD COLUMN IF NOT EXISTS "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "message_board_item_studentGuid_schoolYear_firstSeenAt_idx"
  ON "message_board_item" ("studentGuid", "schoolYear", "firstSeenAt");

UPDATE "message_board_item"
  SET "firstSeenAt" = "updatedAt"
  WHERE "firstSeenAt" > "updatedAt";
