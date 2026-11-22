-- Per-user digest isolation (ADR-0035).
--
-- A digest run used to be one per child. Both parents of a shared child got
-- one dedup ledger, one delivery row and one rendered message between them --
-- so the message carried whichever parent's unanswered consent forms the
-- earliest recipient row pointed at, and whichever run went first silenced the
-- day's items for the other parent. A run is now one (child, subscribing
-- parent), which means `digest_reported_item` and `digest_delivery` need to say
-- whose they are.
--
-- Every statement here is idempotent, because backend/Dockerfile executes this
-- file on every container boot, immediately AFTER `prisma db push` and before
-- the app starts. Production's schema comes from that push, not from this file;
-- the DDL below is repeated with guards so the file also works standalone,
-- which is how the integration tests execute it.
--
-- The new columns are declared with DEFAULT '' for the reason spelled out in
-- 20261117000000_school_year_scoping: `db push --accept-data-loss` can drop and
-- recreate a populated table when a required column arrives with no default.
-- The default makes the add non-destructive; the backfill below supplies the
-- real value.
--
-- Why step 2 copies a child's ledger to the child's other parents, rather than
-- leaving each parent to start from an empty one: before this deploy, ONE
-- per-child run delivered to EVERY enabled recipient of that child. So every
-- existing subscriber has in fact already received everything in that child's
-- ledger. Without the copy, the second parent's first run would re-report the
-- whole active window at them -- today's behaviour, three days of newly
-- assigned homework, fourteen days of hint-matched due homework, seven days of
-- consent forms -- as if none of it had ever been sent.
--
-- There is deliberately no DELETE anywhere in this file. A row left at
-- `userId = ''` is invisible to every per-user query and DigestRetentionService
-- sweeps it within ninety days. Deleting would be the one irreversible
-- statement here, and would re-blast a backlog at any child whose only
-- recipient happened to be toggled off when it ran.

-- 1. Columns and keys. Guarded for a first-ever deploy, where `db push` has
--    not created the tables yet when a standalone run reaches this file.
DO $$
BEGIN
  IF to_regclass('"digest_reported_item"') IS NULL THEN RETURN; END IF;

  ALTER TABLE "digest_reported_item" ADD COLUMN IF NOT EXISTS "userId" TEXT NOT NULL DEFAULT '';

  -- The dedup unique keeps its explicit name (the generated one would exceed
  -- Postgres's 63-character identifier limit) and gains "userId" at the front,
  -- so re-creation is conditional on the column set rather than the name. The
  -- new key is strictly wider than the old one, so it cannot fail on existing
  -- rows whatever they were backfilled to.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'digest_reported_item'
      AND indexname = 'digest_reported_item_dedup_key'
      AND indexdef LIKE '%"userId"%'
  ) THEN
    DROP INDEX IF EXISTS "digest_reported_item_dedup_key";
    CREATE UNIQUE INDEX "digest_reported_item_dedup_key"
      ON "digest_reported_item" ("userId", "studentGuid", "itemType", "itemId", "contentHash");
  END IF;

  -- The checker's two hot lookups. The second omits "studentGuid" because the
  -- consent-form arm dedups across a parent's children on purpose.
  DROP INDEX IF EXISTS "digest_reported_item_studentGuid_contentHash_idx";
  CREATE INDEX IF NOT EXISTS "digest_reported_item_userId_studentGuid_contentHash_idx"
    ON "digest_reported_item" ("userId", "studentGuid", "contentHash");
  CREATE INDEX IF NOT EXISTS "digest_reported_item_userId_contentHash_idx"
    ON "digest_reported_item" ("userId", "contentHash");
END $$;

DO $$
BEGIN
  IF to_regclass('"digest_delivery"') IS NULL THEN RETURN; END IF;

  ALTER TABLE "digest_delivery" ADD COLUMN IF NOT EXISTS "userId" TEXT NOT NULL DEFAULT '';

  -- `listDeliveries` filters on userId and orders by runAt desc.
  CREATE INDEX IF NOT EXISTS "digest_delivery_userId_runAt_idx"
    ON "digest_delivery" ("userId", "runAt");
END $$;

DO $$
BEGIN
  IF to_regclass('"digest_recipient"') IS NULL THEN RETURN; END IF;

  -- A subscription belongs to a parent, not to a chat: without "userId" in the
  -- key, the second parent to link one family group chat for one child found
  -- the first parent's row and only flipped `enabled` on it.
  DROP INDEX IF EXISTS "digest_recipient_studentGuid_channel_address_key";
  CREATE UNIQUE INDEX IF NOT EXISTS "digest_recipient_userId_studentGuid_channel_address_key"
    ON "digest_recipient" ("userId", "studentGuid", "channel", "address");
END $$;

-- 2. Backfill: the child's earliest subscriber owns the rows that exist today,
--    because that is exactly who the pre-deploy code reported consent forms
--    for and logged deliveries as. Resolved over ALL recipient rows rather
--    than only enabled ones -- a parent who toggled their chat off still
--    received everything in the ledger -- and ordered deterministically, so a
--    second run of this file reasons identically to the first.
UPDATE "digest_reported_item" AS i
SET "userId" = (
  SELECT r."userId"
  FROM "digest_recipient" r
  WHERE r."studentGuid" = i."studentGuid"
  ORDER BY r."activeFrom" ASC, r."id" ASC
  LIMIT 1
)
WHERE i."userId" = ''
  AND EXISTS (
    SELECT 1 FROM "digest_recipient" r WHERE r."studentGuid" = i."studentGuid"
  );

UPDATE "digest_delivery" AS d
SET "userId" = (
  SELECT r."userId"
  FROM "digest_recipient" r
  WHERE r."studentGuid" = d."studentGuid"
  ORDER BY r."activeFrom" ASC, r."id" ASC
  LIMIT 1
)
WHERE d."userId" = ''
  AND EXISTS (
    SELECT 1 FROM "digest_recipient" r WHERE r."studentGuid" = d."studentGuid"
  );

-- 3. Give the child's other subscribers the same ledger, so their first
--    per-user run does not re-report a window they have already been sent.
--
--    `id` is supplied explicitly because `@default(cuid())` is generated by the
--    Prisma client, not by the database -- the column has no DB default at all.
--    `claimedBy` and `deliveryId` are forced to NULL: a claim belongs to the
--    run that made it, and a delivery row belongs to the parent it was written
--    for. `confirmedAt`, `reportedFor`, `claimedAt` and `resolvedDueDate` are
--    carried, because they are what "already reported, and deferred to this
--    date" is made of.
--
--    `itemType = 'activity'` is excluded. A consent form's content hash embeds
--    the owning userId (digest-checker.service.ts), so a copy under another
--    parent's userId is a row whose hash that parent can never compute -- dead
--    weight that would never match and never suppress anything.
--
--    ON CONFLICT names the index's columns rather than a constraint: Prisma's
--    `@@unique` is a unique index, and `ON CONSTRAINT` would not find it.
INSERT INTO "digest_reported_item" (
  "id", "userId", "studentGuid", "itemType", "itemId", "contentHash",
  "reportedFor", "claimedAt", "claimedBy", "confirmedAt", "resolvedDueDate",
  "deliveryId"
)
SELECT gen_random_uuid()::text,
       r."userId",
       i."studentGuid",
       i."itemType",
       i."itemId",
       i."contentHash",
       i."reportedFor",
       i."claimedAt",
       NULL,
       i."confirmedAt",
       i."resolvedDueDate",
       NULL
FROM "digest_reported_item" i
JOIN (SELECT DISTINCT "studentGuid", "userId" FROM "digest_recipient") r
  ON r."studentGuid" = i."studentGuid"
 AND r."userId" <> i."userId"
WHERE i."userId" <> ''
  AND i."itemType" <> 'activity'
  AND i."confirmedAt" IS NOT NULL
ON CONFLICT ("userId", "studentGuid", "itemType", "itemId", "contentHash") DO NOTHING;
