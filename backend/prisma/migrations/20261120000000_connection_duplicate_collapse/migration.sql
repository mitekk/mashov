-- Collapse duplicate household_connection rows, so (schoolCode, username) can
-- become a unique key.
--
-- Runs BEFORE `prisma db push`, unlike every other file in this directory.
-- That ordering is the whole point: `db push` creates
-- @@unique([schoolCode, username]) from schema.prisma before any migration SQL
-- executes, and migration 20261117000000_school_year_scoping *deactivated*
-- rather than deleted the duplicates it found. Those rows still exist, so push
-- would hit a unique violation and block startup with no way forward.
--
-- Guarded with to_regclass so a first-ever deploy -- where the table does not
-- exist yet, because push has not run -- is a no-op instead of a boot failure.
-- Idempotent: once collapsed there are no groups left and every statement
-- matches nothing.

DO $$
DECLARE
  dup RECORD;
  keeper TEXT;
BEGIN
  IF to_regclass('public.household_connection') IS NULL THEN
    RAISE NOTICE 'household_connection does not exist yet; nothing to collapse';
    RETURN;
  END IF;

  FOR dup IN
    SELECT "schoolCode", username
    FROM "household_connection"
    GROUP BY "schoolCode", username
    HAVING count(*) > 1
  LOOP
    -- The keeper is the single active row when there is exactly one, else the
    -- most recently touched. `active` first because 20261117000000's whole
    -- purpose was to leave exactly one row active per identity; `updatedAt`
    -- is the tiebreak for a group it never reached.
    SELECT id INTO keeper
    FROM "household_connection"
    WHERE "schoolCode" = dup."schoolCode" AND username = dup.username
    ORDER BY "active" DESC, "lastLoginAt" DESC NULLS LAST, "updatedAt" DESC
    LIMIT 1;

    -- sync_run.householdConnectionId has no foreign key, so these rows would
    -- survive the delete below as danglers rather than erroring. Re-pointing
    -- them at the keeper keeps the sync history readable -- and
    -- FreshnessService reads it per connection, so an orphaned run is a source
    -- that silently reports never_synced.
    UPDATE "sync_run"
    SET "householdConnectionId" = keeper
    WHERE "householdConnectionId" IN (
      SELECT id
      FROM "household_connection"
      WHERE "schoolCode" = dup."schoolCode"
        AND username = dup.username
        AND id <> keeper
    );

    DELETE FROM "household_connection"
    WHERE "schoolCode" = dup."schoolCode"
      AND username = dup.username
      AND id <> keeper;

    RAISE NOTICE 'Collapsed duplicate connections for semel=% username=% onto %',
      dup."schoolCode", dup.username, keeper;
  END LOOP;
END $$;
