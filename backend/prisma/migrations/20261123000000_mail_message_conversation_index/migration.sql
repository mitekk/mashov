-- Index the FK child column `mail_message."conversationId"`.
--
-- Postgres indexes the REFERENCED side of a foreign key for you and the
-- referencing side never. So every unlink paid for two sequential scans of
-- `mail_message` while holding its locks: the delete that reaches a school's
-- messages through their conversation, and the FK check Postgres runs for
-- `mail_conversation`'s own delete. The same scan is on the read path of every
-- conversation open, which lists a conversation's messages by this column.
--
-- IF NOT EXISTS so the file is idempotent and survives the `prisma db push`
-- boot, which creates the index from the schema first.

CREATE INDEX IF NOT EXISTS "mail_message_conversationId_idx"
  ON "mail_message" ("conversationId");
