# ADR-0037: Inbox Mail Is Its Own Message, on Its Own Cadence, with Its Own Ledger

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent

## Context and Problem Statement

Everything this project had ever pushed to a parent was one thing: the per-child daily report
ADR-0026 introduced. An audit of what a parent actually receives per student found behaviour
and attendance, newly assigned homework, early release, unanswered consent forms, and a derived
due-tomorrow estimate — and nothing else. Inbox mail, message-board notices, user
notifications, and every attachment were synced and reached the parent nowhere but the website.

Inbox mail is the worst of those omissions, because it is where a school actually *asks a
parent for something*. A permission slip with a Thursday deadline sat in a table until someone
opened the app. The afternoon report could not carry it either: mail belongs to a household,
not to a child, so there is no child to file it under.

What had to be decided: where the code lives, when it runs, what stops a message being sent
twice, and which chats get it.

## Decision

**Its own module, `backend/src/inbox-notify/`, and not part of `DigestModule`.**

Four differences, and each on its own would have been survivable; together they are a different
feature. Mail is household-scoped rather than per child, so `DigestRunResult`'s `studentGuid`
has nothing to put in it. It needs no model call: a school's mail is already prose written for a
parent, and summarizing it would only lose detail. It wants a ten-minute cadence rather than
hourly in the afternoon, because "the form is due tomorrow" is not news at 19:00. And a separate
message was the explicit requirement — the mail must not be folded into the child's report.

It reuses `TelegramSender`, `householdMailScope`, `deriveIsUnread`'s read-override rule, and the
digest's `STALE_CLAIM_MS`. Those are deliberate: two copies of the mail visibility rule is what
produced the badge asymmetry `unreadBadge` documents, and two staleness windows would race each
other.

**A ten-minute cron, with quiet hours checked inside the handler.**

`@Cron('*/10 * * * *')`. The run is four narrow local queries, no upstream HTTP and no model
call, so the cadence is nearly free.

Quiet hours are **not** in the cron expression. Partly because a `@Cron` expression is evaluated
when the decorator runs and cannot come from `ConfigService` — but mostly because mail arriving
at 02:00 must **wait for 07:00**, not be dropped. The lookback window
(`INBOX_NOTIFY_LOOKBACK_HOURS`, 24h) is what carries it across, which is why that value is
documented as the carry-over window and must never be shorter than the quiet hours are long.

The quiet-hours parser **fails open**: an unreadable window means "not quiet". A typo that makes
the window permanently quiet kills the feature with no error anyone sees; a typo that makes it
never quiet costs one message at an awkward hour.

**A dedicated ledger table, `mail_notified_message`, not a `DigestReportedItem` with a sentinel.**

`DigestReportedItem.studentGuid` is required with no default, and its consent-form dedup arm
queries `{userId, contentHash}` with **no** `studentGuid` at all — household-wide on purpose
(ADR-0035). Any sentinel guid would collide with that arm and start suppressing real consent
forms. The new table runs the same claim → send → confirm-or-release protocol, keyed per
`address` as well as per user, so a chat linked after some mail arrived is not silenced by
another chat's history.

**The conversation read is stricter than `householdMailScope`, and this is the one place in the
project that deviates from it.**

That helper admits `householdConnectionId: null` to every caller, because NULL means "ownership
unknown" rather than "nobody's", and hiding those rows would empty the inbox on a deployment
that has not re-synced. That trade is right for a list view a parent chose to open and wrong for
outbound egress: two households both match a NULL-stamped row, so a family chat both parents
linked receives the same mail twice — and in the worst case a stranger's conversation is pushed
into a parent's Telegram, which is forwardable and permanent in a way a list view is not. The
notifier therefore reads only rows stamped to the parent's own connections. The cost is that a
conversation the ownership backfill has not reached is never announced; the parent still sees it
in the app, which is the safe direction for a push.

**The conversation detail is fetched before the text is rendered, behind a second token.**

`MailInboxTask` stores message **metadata only** — `apis/get-api-mail-inbox-conversations.md`
shows the inbox list payload carries no `body` and no `files` at all, and both are written only
when a parent opens the thread. Without a fetch, every notification about mail nobody has opened
— which is every mail this feature exists to announce — would be a header, a sender, a subject
and nothing under it, and no attachment would ever be forwarded.

The notifier cannot fetch it itself (it may not reach Mashov), so `UPSTREAM_MAIL` sits in the
same global module as `MEDIA_DELIVERY` and calls `MailService.getConversationDetail` — the same
method the HTTP route uses, which asserts visibility with the `userId`, fetches only when no
message in the thread has a renderable body, and persists what it gets. No new upstream call
pattern and no new authorization path; the existing one, reached from a cron with the
subscribing parent's own id. A failure costs the parent the body of the notification, never the
notification itself.

**Recipients are the parent's `digest_recipient` rows, deduped per (channel, address).**

A parent who linked one family group chat for three children has three rows and one inbox; three
copies of the same mail is what they would read as the feature being broken.

**Failure handling is per address *and* per message.** The digest is all-or-nothing per child;
here one blocked chat out of three must not cost the other two their confirmation — and within
one chat, a message that was delivered must stay confirmed when a later one fails. Releasing the
whole batch would re-send the ones that already arrived on every ten-minute tick for as long as
a sustained 429 or an upstream 5xx window lasted, which is the digest's old
retry-forever failure in a shape the digest could never have: one digest run is one send. A
permanent refusal confirms everything and disables the recipient, because retrying has no
destination left.

**Everything is counted from what the run OWNS, never from what it saw.** A concurrent run can
have claimed some of the candidates, so deciding whether to summarize — or telling the parent
"6 new messages" — from the candidate count states a number that is not what went out, and logs
`messageText` that was never sent.

**A run-log row is written only when a chat had something to be told.** The cron fires 144 times
a day; a row per quiet tick per parent would bury `digest_delivery` long before the retention
sweep reached it. `DigestDelivery` gains `kind` ('digest' | 'inbox') and a nullable
`studentGuid` rather than a second table, because one history is what answers "what have you
sent me".

## Consequences

**Good.** Off by default (`INBOX_NOTIFY_ENABLED=false`) and silent even when on
(`INBOX_NOTIFY_DRY_RUN=true`), exactly like the digest. The dry run claims nothing, so the first
real run still has news. Selection honours the local read override, the archived label, and the
parent's own replies, so the message is about mail the parent has not already dealt with.

**Accepted and worth stating plainly.** A chat a parent linked for a single child now also
receives that household's mail. The subscription row means "send things here", and mail has no
child to scope it by. A per-recipient `mailEnabled` column is the follow-up if that turns out
wrong; it is deliberately not built now, because a column with no UI toggle behind it is a
feature nobody can see or turn off.

**Own-reply detection is best-effort.** It compares `senderId` to the owning connection's
`upstreamUserId`, and falls back to `MailMessage.isNew` when that column is null — an
unattributed row, or a connection that has not logged in since the column was added.
`mail/unread.ts` documents at length why `isNew` on a message is a weak read-state signal; it is
used here only to tell an arrival from an outgoing reply, which is a different question, and the
failure direction is one unnecessary notification rather than a missed one.

**Volume is bounded but not small.** Up to `INBOX_NOTIFY_MAX_PER_RUN` (5) messages per chat per
tick; above it one summary goes out and the whole batch is claimed, so the next run does not
then send them one by one. What is still missing is a daily cap, and a school that mails daily
will be noticeable.

**The ledger grows per message per chat.** A household with three linked chats writes three rows
per message. `DigestRetentionService` prunes it on the same 90-day cutoff as the rest of the
digest history, in its own arm so one failing delete cannot leave another table unbounded.
