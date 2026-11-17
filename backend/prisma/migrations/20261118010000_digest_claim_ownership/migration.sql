-- Digest claim ownership and deferred deadline resolution.
--
-- Two columns that between them close three defects found in review:
--
--  * `claimedBy` makes a claim readable back. `createMany({skipDuplicates})`
--    returns how many rows were inserted but never which, so a run could not
--    tell its own claims from another run's. That made two bugs possible: a
--    row orphaned by a hard kill could never be taken over (the insert
--    conflicts, the count comes back 0, and the run concludes someone else
--    owns it -- forever), and a failing run could delete a claim a concurrent
--    run was holding.
--
--  * `resolvedDueDate` records the deadline the model read out of homework
--    text when that deadline was not tomorrow. The row then stays instead of
--    being deleted, so the model is not asked the same question every hour for
--    a fortnight, and the checker re-admits the item on the day its deadline
--    really is tomorrow instead of burying it.
--
-- Additive and nullable, so safe under `prisma db push --accept-data-loss`,
-- which is how production applies schema.

ALTER TABLE "digest_reported_item" ADD COLUMN "claimedBy" TEXT;
ALTER TABLE "digest_reported_item" ADD COLUMN "resolvedDueDate" DATE;

-- The checker's hottest query: one lookup per child per run against the hashes
-- it just computed. The dedup unique index leads with studentGuid, so without
-- this Postgres scans every row that child has ever had.
CREATE INDEX "digest_reported_item_studentGuid_contentHash_idx" ON "digest_reported_item"("studentGuid", "contentHash");
