-- Tracks the last login roster a child appeared in. Mashov does not move a
-- departed child to `inactiveChildren`; they simply stop appearing in
-- `children[]`, which nothing recorded.
ALTER TABLE "student" ADD COLUMN "lastSeenInRosterAt" TIMESTAMP(3);

-- Backfill from updatedAt. Every write to this table is a roster upsert from a
-- login payload (auth.service, session.service, mashov-session.service), so
-- updatedAt is already the moment the child last appeared in a roster. That
-- makes the backfill accurate rather than merely safe: a child still enrolled
-- gets a recent timestamp, and one who left keeps the stale one that will
-- retire them on the next sweep.
UPDATE "student" SET "lastSeenInRosterAt" = "updatedAt" WHERE "lastSeenInRosterAt" IS NULL;

CREATE INDEX IF NOT EXISTS "student_isActive_lastSeenInRosterAt_idx"
  ON "student"("isActive", "lastSeenInRosterAt");
