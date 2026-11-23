-- Parent feedback channel: one write-only table of self-contained reports.
--
-- Production's schema comes from `prisma db push --accept-data-loss` on every
-- boot, so this file is the committed record rather than the thing that runs.
-- Every statement here is DDL and every one is executable under that flag: a
-- new table and its two indexes, nothing else. There is no data statement, so
-- boot does not need to execute it (see src/prisma/boot-migrations.spec.ts).
--
-- No foreign key on "userId": Postgres has no `ADD CONSTRAINT IF NOT EXISTS`,
-- so an FK cannot be written idempotently, and a row whose whole point is to
-- outlive a merged or unlinked household must not be blocked by one. See
-- ADR-0043 and the doc comment on `model Feedback`.

CREATE TABLE IF NOT EXISTS "feedback" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "subject"         TEXT NOT NULL,
  "subjectOther"    TEXT,
  "contactEmail"    TEXT,
  "content"         TEXT NOT NULL,
  "pagePath"        TEXT,
  "userAgent"       TEXT,
  "viewportWidth"   INTEGER,
  "viewportHeight"  INTEGER,
  "appVersion"      TEXT,
  "mashovUserId"    TEXT NOT NULL,
  "username"        TEXT NOT NULL,
  "displayName"     TEXT NOT NULL,
  "schoolsSnapshot" JSONB NOT NULL DEFAULT '[]',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- The per-user rate limit counts a user's rows in the last hour.
CREATE INDEX IF NOT EXISTS "feedback_userId_createdAt_idx"
  ON "feedback" ("userId", "createdAt");

-- Reading the table is "newest first".
CREATE INDEX IF NOT EXISTS "feedback_createdAt_idx"
  ON "feedback" ("createdAt");
