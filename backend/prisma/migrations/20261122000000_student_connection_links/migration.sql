-- Child visibility becomes a set of connections (ADR-0031).
--
-- `Student.householdConnectionId` was carrying two jobs: routing (which
-- credentials to use upstream) and visibility (which users may see the child).
-- One value is right for the first and wrong for the second, so two parents
-- with their own Mashov accounts at one school evicted each other's children
-- on every sync. This table is the visibility edge; the column keeps routing.
--
-- Written to be idempotent and to survive the `prisma db push` boot: push
-- creates the table from the schema, and this file only backfills. The DDL is
-- repeated with IF NOT EXISTS so the file also works standalone (integration
-- tests execute it against a fresh database).

CREATE TABLE IF NOT EXISTS "student_connection" (
  "studentGuid"           TEXT NOT NULL,
  "householdConnectionId" TEXT NOT NULL,
  "firstSeenAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenInRosterAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_connection_pkey" PRIMARY KEY ("studentGuid", "householdConnectionId")
);

CREATE INDEX IF NOT EXISTS "student_connection_householdConnectionId_idx"
  ON "student_connection" ("householdConnectionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'student_connection_studentGuid_fkey'
  ) THEN
    ALTER TABLE "student_connection"
      ADD CONSTRAINT "student_connection_studentGuid_fkey"
      FOREIGN KEY ("studentGuid") REFERENCES "student" ("studentGuid")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'student_connection_householdConnectionId_fkey'
  ) THEN
    ALTER TABLE "student_connection"
      ADD CONSTRAINT "student_connection_householdConnectionId_fkey"
      FOREIGN KEY ("householdConnectionId") REFERENCES "household_connection" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: one link per child that already carries a routing stamp. Every
-- stamp was written from a login roster, so it IS evidence that connection
-- lists the child -- exactly what a link records.
--
-- Children with no stamp get no link, which is correct: "ownership unknown"
-- stays readable by any caller until the next roster refresh links it, the
-- same rule the NULL stamp already had.
INSERT INTO "student_connection" ("studentGuid", "householdConnectionId", "firstSeenAt", "lastSeenInRosterAt")
SELECT s."studentGuid",
       s."householdConnectionId",
       COALESCE(s."lastSeenInRosterAt", s."updatedAt", CURRENT_TIMESTAMP),
       COALESCE(s."lastSeenInRosterAt", s."updatedAt", CURRENT_TIMESTAMP)
FROM "student" s
JOIN "household_connection" c ON c."id" = s."householdConnectionId"
WHERE s."householdConnectionId" IS NOT NULL
ON CONFLICT ("studentGuid", "householdConnectionId") DO NOTHING;
