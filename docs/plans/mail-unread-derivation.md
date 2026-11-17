# Mail unread badge reads higher than Mashov's own count

(Plan as handed to the executor; see git history of this branch for the implementation.)

## Root cause, as measured (not as planned)

The plan's leading hypothesis -- that `conv.isNew` is sticky and `messages[].isNew` is the real
read state -- was **refuted** by the plan's own confirmation queries, run against production:

```
Q1: active_connections = 1, cachedNewCount = 39          -> H-C dead, one mailbox
Q2: rawPayload->messages is an array for all 117 rows    -> instrument valid
Q3: local_unread=39  unusable_payload=0  sticky_conv_isnew=39
    genuinely_unread=0  stale_orphans=23
Q4: one group only: folder=0, msg_new=false, msg_deleted=false, 39 conversations
```

`stale_orphans` is a strict subset of `local_unread`, so the rows the last successful walk did
refresh number 39 - 23 = **16** -- exactly `unreadConversations`. And every message of all 39
came back `isNew: false`, including those 16. So:

- **`messages[].isNew` is not a read-state signal in the inbox list payload.** Deriving `isUnread`
  from it would have set the badge to **0**, the failure direction that hides mail.
- **`conv.isNew` is correct** for rows upstream still returns.
- **The whole gap is missing reconciliation (H-B):** 16 genuinely unread + 23 rows upstream had
  stopped returning that nothing ever cleared.

Definition of unread: a conversation is unread iff it is not archived, upstream still returns it
with `isNew: true`, and the user has not marked it read locally since the newest message arrived.

Tasks:
1. Failing tests in `backend/src/sync/tasks/mail-inbox.task.spec.ts` + unit table in
   `backend/src/mail/unread.spec.ts`.
2. `backend/src/mail/unread.ts` exporting `deriveIsUnread(conv, locallyReadThrough)` -- reads
   `conv.isNew` and applies the local read override, using `messages[].sendTime` (a timestamp, not
   a flag) only to decide whether new mail has arrived since the user read it. Called from the
   inbox walk and from `persistUpstreamConversationDetail`.
3. `locallyReadThroughAt DateTime?` on `MailConversation`; set in `markConversationsRead` from
   `max(mailMessage.sendTime)`, cleared by `markUnread`/`unarchive`; batch-selected per page by the
   inbox walk.
4. Reconciliation sweep in `MailInboxTask` for orphans, behind gates. **This is the fix for the
   reported bug** -- mandatory, not conditional, since Q3 measured 23 orphans.
5. Observability: drift-aware log level, `upstreamCount`/`localCount` on `SyncRun`.

No data repair, no new migration directory, no Dockerfile change: all new columns are nullable and
additive, so `prisma db push` handles them.
