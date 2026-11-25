-- The password-recovery audit trail: one row per completed reset.
--
-- `model CredentialRecoveryAudit` shipped without this file. Production's
-- schema comes from `npx prisma db push --accept-data-loss` on every boot
-- (backend/Dockerfile), so the table IS created there from the model and
-- `writeAudit` has not been throwing — the trail is not empty. This file is the
-- committed record every other table has, and it is what `prisma migrate
-- deploy` needs against a fresh or scratch database, where `db push` never
-- runs.
--
-- Every statement is idempotent DDL and nothing here is a data statement, so
-- boot does not need to execute it (see src/prisma/boot-migrations.spec.ts).
--
-- What is deliberately NOT a column: the recovery code, the new password, and
-- the raw ID number. `idNumberHash` is an HMAC keyed with the deploy's own
-- secret — a plain digest of an Israeli ID number is a rainbow table away from
-- the original, and the point is to keep a national identifier out of a
-- support-readable table while still being able to count resets per identity.
--
-- No foreign key: this flow is unauthenticated and keyed by ID number, so there
-- is no `AppUser` to point at — whoever completed recovery proved control of the
-- school's contact details, not ownership of one of our households. See
-- ADR-0042 and the doc comment on `model CredentialRecoveryAudit`.

CREATE TABLE IF NOT EXISTS "credential_recovery_audit" (
  "id"           TEXT NOT NULL,
  "schoolCode"   INTEGER NOT NULL,
  "idNumberHash" TEXT NOT NULL,
  "ip"           TEXT NOT NULL,
  "at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credential_recovery_audit_pkey" PRIMARY KEY ("id")
);

-- "how many resets at this school lately" -- the abuse-amplifier question.
CREATE INDEX IF NOT EXISTS "credential_recovery_audit_schoolCode_at_idx"
  ON "credential_recovery_audit" ("schoolCode", "at");

-- "how many resets for this identity lately".
CREATE INDEX IF NOT EXISTS "credential_recovery_audit_idNumberHash_at_idx"
  ON "credential_recovery_audit" ("idNumberHash", "at");
