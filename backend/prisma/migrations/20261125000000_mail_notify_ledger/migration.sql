-- Inbox notifications: a dedup ledger of their own, and a `kind` on the run log.
--
-- Production's schema comes from `prisma db push --accept-data-loss` on every
-- boot, so this file is the committed record rather than the thing that runs.
-- Every statement here is DDL and every one is executable under that flag: a
-- new table, a defaulted column, and a column relaxed from NOT NULL to NULL.
-- There is no data statement, so boot does not need to execute it (see
-- src/prisma/boot-migrations.spec.ts).

CREATE TABLE IF NOT EXISTS "mail_notified_message" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "address"        TEXT NOT NULL,
  "messageId"      TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contentHash"    TEXT NOT NULL,
  "notifiedFor"    DATE NOT NULL,
  "claimedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedBy"      TEXT,
  "confirmedAt"    TIMESTAMP(3),

  CONSTRAINT "mail_notified_message_pkey" PRIMARY KEY ("id")
);

-- Named explicitly in the schema too: the generated name would run past
-- Postgres's 63-character identifier limit and be silently truncated, drifting
-- `db push` from this file.
CREATE UNIQUE INDEX IF NOT EXISTS "mail_notified_message_dedup_key"
  ON "mail_notified_message" ("userId", "channel", "address", "messageId", "contentHash");

CREATE INDEX IF NOT EXISTS "mail_notified_message_userId_claimedAt_idx"
  ON "mail_notified_message" ("userId", "claimedAt");

-- The run log now carries rows that are not about one child.
ALTER TABLE "digest_delivery" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'digest';
ALTER TABLE "digest_delivery" ALTER COLUMN "studentGuid" DROP NOT NULL;
