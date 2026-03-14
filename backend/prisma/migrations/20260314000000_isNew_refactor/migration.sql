-- Migration: isNew-refactor
-- Rename isUnread -> isNew on mail tables, rename cachedUnreadCount -> cachedNewCount,
-- add isNew/isArchived to homework_item and behavior_item, drop ReadState table.

-- Rename columns on mail_conversation
ALTER TABLE "mail_conversation" RENAME COLUMN "isUnread" TO "isNew";

-- Rename columns on mail_message
ALTER TABLE "mail_message" RENAME COLUMN "isUnread" TO "isNew";

-- Rename cachedUnreadCount -> cachedNewCount on household_connection
ALTER TABLE "household_connection" RENAME COLUMN "cachedUnreadCount" TO "cachedNewCount";

-- Add isNew and isArchived to homework_item (DEFAULT false handles backfill)
ALTER TABLE "homework_item" ADD COLUMN "isNew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "homework_item" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- Add isNew and isArchived to behavior_item (DEFAULT false handles backfill)
ALTER TABLE "behavior_item" ADD COLUMN "isNew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "behavior_item" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- Drop ReadState table
DROP TABLE IF EXISTS "read_state";
