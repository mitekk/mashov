-- Message board notices: when we first saw one.
--
-- Mashov's payload carries no creation date, and `updatedAt` is churned by the
-- 06:00 upsert, so neither can mean "new". `firstSeenAt` can -- but only once
-- the rows already in the table carry a value that is not "now".
--
-- `prisma db push` adds the column with DEFAULT now(), which Postgres writes
-- into every existing row. So on the deploy that adds it, the whole current
-- board sits inside DIGEST_BOARD_LOOKBACK_DAYS and the next digest run
-- announces all of it, per child, in one message. The UPDATE below is what
-- prevents that, and it is why this file is in the Dockerfile's boot chain:
-- push applies DDL and silently skips every data statement (see
-- src/prisma/boot-migrations.spec.ts).
--
-- It backfills to a fixed 30 days in the past, NOT to `updatedAt`.
-- MessageBoardTask's upsert writes an `update` payload for every still-posted
-- notice on every 06:00 run, so `@updatedAt` is always within the last day --
-- it would place the entire board inside the lookback and guarantee the blast
-- this statement exists to prevent. 30 days clears any lookback an operator
-- would plausibly set (the default is 2). There is no `createdAt` on this
-- table to use instead, and the cost of backdating is only that a notice
-- genuinely posted the same morning as the deploy is not announced -- once.
--
-- It must run exactly ONCE, not merely be idempotent, and that is why it is
-- gated by a marker row in `data_backfill` rather than by a timestamp. A
-- notice the sync task genuinely created minutes before a restart is
-- indistinguishable from a push default by its `firstSeenAt` alone, so a
-- time-based guard would backdate it out of the lookback and the parent would
-- never hear about it. The marker table is declared in schema.prisma because
-- `db push --accept-data-loss` drops a table the schema does not mention,
-- which would reset the marker on every boot -- the same reasoning as
-- 20261124000000_digest_per_user.

ALTER TABLE "message_board_item"
  ADD COLUMN IF NOT EXISTS "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "message_board_item_studentGuid_schoolYear_firstSeenAt_idx"
  ON "message_board_item" ("studentGuid", "schoolYear", "firstSeenAt");

-- The marker table. Repeated here with IF NOT EXISTS so the file also works
-- standalone, the same reason the DDL above is.
CREATE TABLE IF NOT EXISTS "data_backfill" (
  "id"        TEXT NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_backfill_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "data_backfill" WHERE "id" = 'message-board-first-seen') THEN
    RETURN;
  END IF;

  UPDATE "message_board_item"
    SET "firstSeenAt" = now() - interval '30 days';

  INSERT INTO "data_backfill" ("id") VALUES ('message-board-first-seen');
END $$;
