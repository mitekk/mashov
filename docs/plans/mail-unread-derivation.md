# Mail unread badge reads higher than Mashov's own count

(Plan as handed to the executor; see git history of this branch for the implementation.)

Root cause: `mail-inbox.task.ts` stores `conv.isNew` (a sticky conversation-level flag) as
`isUnread`, so the local unread count and the inbox `new` filter are both inflated relative to
Mashov's `unreadConversations`.

Definition of unread (authoritative): a conversation is unread iff it is not archived and has at
least one message with `isNew: true` that is not deleted.

Tasks:
1. Failing tests in `backend/src/sync/tasks/mail-inbox.task.spec.ts` + unit table in
   `backend/src/mail/unread.spec.ts`.
2. `backend/src/mail/unread.ts` exporting `deriveIsUnread(conv, locallyReadThrough)`; call it from
   the inbox walk and from `persistUpstreamConversationDetail`.
3. `locallyReadThroughAt DateTime?` on `MailConversation`; set in `markConversationsRead` from
   `max(mailMessage.sendTime)`, cleared by `markUnread`/`unarchive`; batch-selected per page by the
   inbox walk.
4. Reconciliation sweep in `MailInboxTask` for orphans, behind gates.
5. Observability: drift-aware log level, `upstreamCount`/`localCount` on `SyncRun`.

No data repair, no new migration directory, no Dockerfile change: all new columns are nullable and
additive, so `prisma db push` handles them.
