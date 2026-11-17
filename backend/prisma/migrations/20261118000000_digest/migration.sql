-- Per-child daily activity digest.
--
-- Three new tables plus the indexes the digest checker needs. As with the
-- school-year migration, production's schema comes from `prisma db push` on
-- boot, not from this file; it exists for repo and CI parity. Everything here
-- is additive, so it is safe under `--accept-data-loss`.

-- CreateTable
CREATE TABLE "digest_recipient" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studentGuid" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digest_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_reported_item" (
    "id" TEXT NOT NULL,
    "studentGuid" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "reportedFor" DATE NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "deliveryId" TEXT,

    CONSTRAINT "digest_reported_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_delivery" (
    "id" TEXT NOT NULL,
    "studentGuid" TEXT NOT NULL,
    "reportFor" DATE NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "channel" TEXT,
    "messageText" TEXT,
    "usedLlm" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,

    CONSTRAINT "digest_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "digest_recipient_studentGuid_channel_address_key" ON "digest_recipient"("studentGuid", "channel", "address");
CREATE INDEX "digest_recipient_studentGuid_enabled_idx" ON "digest_recipient"("studentGuid", "enabled");
CREATE INDEX "digest_recipient_userId_idx" ON "digest_recipient"("userId");

-- The dedup ledger's uniqueness is what makes the digest at-most-once; the
-- contentHash is part of the key so an edited item re-reports as changed.
CREATE UNIQUE INDEX "digest_reported_item_dedup_key" ON "digest_reported_item"("studentGuid", "itemType", "itemId", "contentHash");
CREATE INDEX "digest_reported_item_studentGuid_reportedFor_idx" ON "digest_reported_item"("studentGuid", "reportedFor");

CREATE INDEX "digest_delivery_studentGuid_reportFor_idx" ON "digest_delivery"("studentGuid", "reportFor");

-- AddForeignKey
ALTER TABLE "digest_recipient" ADD CONSTRAINT "digest_recipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes the digest checker needs on existing tables. None existed: the
-- composite uniques lead with studentGuid, so child lookups were covered but
-- date-range scans were not.
CREATE INDEX "homework_item_studentGuid_schoolYear_lessonDate_idx" ON "homework_item"("studentGuid", "schoolYear", "lessonDate");
CREATE INDEX "behavior_item_studentGuid_schoolYear_lessonDate_idx" ON "behavior_item"("studentGuid", "schoolYear", "lessonDate");
CREATE INDEX "behavior_item_studentGuid_schoolYear_eventAt_idx" ON "behavior_item"("studentGuid", "schoolYear", "eventAt");

-- Unrelated but adjacent: FreshnessService.getAllSourceHealth() table-scanned
-- sync_run, which had no index at all and grows without bound.
CREATE INDEX "sync_run_source_startedAt_idx" ON "sync_run"("source", "startedAt");
