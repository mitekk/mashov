-- Phase 2 Auth Migration
-- Adds AppUser, AppSession, UserItemState tables
-- Adds userId FK to HouseholdConnection
-- Renames MailConversation.isNew -> isUnread
-- Removes isNew/isArchived from HomeworkItem and BehaviorItem
-- Adds householdConnectionId to SyncRun

-- Create AppUser table
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "mashovUserId" TEXT NOT NULL,
    "semel" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_user_mashovUserId_key" ON "app_user"("mashovUserId");

-- Create AppSession table
CREATE TABLE "app_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_session_sessionToken_key" ON "app_session"("sessionToken");
CREATE INDEX "app_session_sessionToken_idx" ON "app_session"("sessionToken");

ALTER TABLE "app_session" ADD CONSTRAINT "app_session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create UserItemState table
CREATE TABLE "user_item_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "isNew" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_item_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_item_state_userId_itemType_itemId_key"
    ON "user_item_state"("userId", "itemType", "itemId");

-- Add userId to HouseholdConnection
ALTER TABLE "household_connection" ADD COLUMN "userId" TEXT;

ALTER TABLE "household_connection" ADD CONSTRAINT "household_connection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rename isNew -> isUnread on mail_conversation (Phase 1 used isNew; Phase 2 migrates to isUnread for mail)
ALTER TABLE "mail_conversation" RENAME COLUMN "isNew" TO "isUnread";

-- Remove isNew and isArchived from homework_item (moved to user_item_state)
ALTER TABLE "homework_item" DROP COLUMN IF EXISTS "isNew";
ALTER TABLE "homework_item" DROP COLUMN IF EXISTS "isArchived";

-- Remove isNew and isArchived from behavior_item (moved to user_item_state)
ALTER TABLE "behavior_item" DROP COLUMN IF EXISTS "isNew";
ALTER TABLE "behavior_item" DROP COLUMN IF EXISTS "isArchived";

-- Add householdConnectionId to sync_run
ALTER TABLE "sync_run" ADD COLUMN "householdConnectionId" TEXT;
