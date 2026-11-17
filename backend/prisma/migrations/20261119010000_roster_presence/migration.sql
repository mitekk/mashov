-- Tracks the last login roster a child appeared in. Mashov does not move a
-- departed child to `inactiveChildren`; they simply stop appearing in
-- `children[]`, which nothing recorded.
--
-- Every statement here is idempotent, because this file is executed on every
-- container boot by backend/Dockerfile, immediately after `prisma db push`.
-- That is not belt-and-braces: production never runs `migrate deploy`, and
-- `db push` reconciles schema only. It adds the column below for free and
-- skips the backfill entirely, which left the column NULL for every row --
-- and the sweep never touches NULL, so a departed child was never retired.
ALTER TABLE "student" ADD COLUMN IF NOT EXISTS "lastSeenInRosterAt" TIMESTAMP(3);

-- Backfill from updatedAt. Every write to this table is a roster upsert from a
-- login payload (auth.service, session.service, mashov-session.service), so
-- updatedAt is already the moment the child last appeared in a roster. That
-- makes the backfill accurate rather than merely safe: a child still enrolled
-- gets a recent timestamp, and one who left keeps the stale one that will
-- retire them on the next sweep.
UPDATE "student" SET "lastSeenInRosterAt" = "updatedAt" WHERE "lastSeenInRosterAt" IS NULL;

CREATE INDEX IF NOT EXISTS "student_isActive_lastSeenInRosterAt_idx"
  ON "student"("isActive", "lastSeenInRosterAt");
