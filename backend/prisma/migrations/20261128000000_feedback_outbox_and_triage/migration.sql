-- Feedback delivery outbox + operator triage state (ADR-0045).
--
-- Production's schema comes from `prisma db push --accept-data-loss` on every
-- boot, so this file is the committed record rather than the thing that runs.
-- Every statement here is DDL and every one is idempotent: five nullable or
-- defaulted columns and one index. There is no data statement, so boot does
-- not need to execute it (see src/prisma/boot-migrations.spec.ts).
--
-- Still no foreign key on "userId": Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`, and a row whose whole point is to outlive a merged or unlinked
-- household must not be blocked by one. See ADR-0044.

-- Outbox state for the operator notification. Null = not yet delivered.
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

-- Delivery attempts spent. Retired at FEEDBACK_NOTIFY_MAX_ATTEMPTS (3).
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "notifyAttempts" INTEGER NOT NULL DEFAULT 0;

-- Last failure, for the admin detail view. Token already redacted by the sender.
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "notifyError" TEXT;

-- Triage state: stamped the first time an operator opens the detail view.
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);

-- Triage state: set explicitly when an operator has answered the parent.
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);

-- The outbox scan: undelivered rows, oldest first.
CREATE INDEX IF NOT EXISTS "feedback_notifiedAt_createdAt_idx"
  ON "feedback" ("notifiedAt", "createdAt");
