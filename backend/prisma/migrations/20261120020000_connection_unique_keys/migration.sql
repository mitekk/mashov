-- (schoolCode, username) as the identity of a Mashov account.
--
-- The code already treats it as that identity -- `auth.service.ts` looks a
-- connection up by exactly this pair -- but looked it up with `findFirst`, so
-- sign-in adoption would be racy: two concurrent sign-ins could both decide
-- they were creating the connection.
--
-- A FULL unique index, never a partial `WHERE active` one. Prisma cannot
-- express a partial index, so the next `prisma db push` would drop it and the
-- constraint would disappear with no error anywhere.
--
-- The duplicates that make this index possible to create are collapsed by
-- 20261120000000_connection_duplicate_collapse, which the Dockerfile runs
-- BEFORE `db push` for that reason.
--
-- The other three collision keys -- notification_event,
-- behavior_type_reference and school_activity, all keyed on per-school Mashov
-- counters -- are swapped in 20261121000000_connection_collision_keys, in the
-- same change as the upserts that adapt to them.

CREATE UNIQUE INDEX IF NOT EXISTS "household_connection_schoolCode_username_key"
  ON "household_connection"("schoolCode", "username");
