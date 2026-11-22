# ADR-0035: A Digest Run Is One Child and One Parent, Not One Child

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent
- **Supersedes**: [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md)'s per-child framing
  — specifically "which parent owns the [consent-form] section in a two-parent household is
  decided by the earliest `activeFrom` among the child's recipients"
- **Builds on**: [ADR-0031](0031-child-visibility-is-a-set-of-connections.md) (a child's
  visibility is a set of connections), [ADR-0033](0033-parent-driven-telegram-linking.md)
  (`ownsStudentForDelivery`, and the parent-driven link that made these rows user-created),
  [ADR-0027](0027-derived-homework-deadlines.md) (the deferral the ledger records)
- **Implemented by**: `backend/prisma/schema.prisma`,
  `backend/prisma/migrations/20261124000000_digest_per_user/migration.sql`,
  `backend/src/digest/`, `backend/src/connection/connection.service.ts`,
  `backend/src/school-links/school-links.service.ts`,
  `backend/src/telegram/telegram-link.service.ts`,
  `tests/integration/digest-user-isolation.test.ts`

## Context and Problem Statement

ADR-0026 built the digest around the child: one run per opted-in child, one dedup ledger keyed by
`studentGuid`, one delivery row, one rendered message, sent to every enabled recipient of that
child. With one parent per household that is exactly right, and it was the state of the world
until ADR-0033 let parents link their own Telegram — at which point a second parent could
subscribe to a child the first parent had already subscribed to.

An audit of that path found three ways one parent's data reached another parent's chat, or kept
flowing after it should have stopped. All three are between users who have — or once had — a
legitimate link to the child; `ownsStudentForDelivery` already refuses an unrelated user. But
per-parent isolation is what the app promises, and these broke it.

**Revocation never reached the subscription.** `prepareConnectionDeletion` deleted digest rows
only for children *no other* connection listed. A parent who disconnected their school therefore
kept receiving a shared child's behaviour remarks indefinitely — the subscription outlived the
connection it was granted under — and in the mirror image, because the same deletes were keyed on
`studentGuid` alone, for a child nobody else listed they took *both* parents' rows. The
connection-adoption path repointed a `HouseholdConnection` to a different `AppUser` and left the
old owner's subscriptions behind entirely, and delivery itself never re-asked the ownership
question.

**The consent-forms section leaked across parents.** `listDeliveryTargets` collapsed to one target
per child and picked one owning `userId` — the earliest subscriber. That parent's unanswered
`SchoolActivity` rows were rendered into the single message sent to *every* recipient of the
child, so the second parent was told "ממתינים לתשובתך" about forms that were not theirs. The
text also landed in `GET /digest/deliveries`, which scoped by "children I hold a recipient for",
so each parent could read the other's `messageText`.

**The two parents shared one row.** `DigestRecipient`'s unique key omitted `userId`, so the second
parent's START found the first parent's row and only flipped `enabled: true` on it. They got no
row at all: their wizard reported a link with zero children, their per-child toggles did nothing,
and their disconnect could not remove it.

## Decision

A digest run is one **(child, subscribing parent)**. Each has its own `runId`, its own dedup
ledger rows, its own delivery log row, and its own recipient rows — and dies with the connection
that justified it.

- `DigestReportedItem.userId` joins the dedup unique key, `DigestDelivery.userId` records whose
  run wrote the row, and `DigestRecipient`'s unique key becomes
  `[userId, studentGuid, channel, address]`.
- `listDeliveryTargets` returns one target per (user, child) with that user's own earliest
  `activeFrom`, and re-checks `ownsStudentForDelivery` plus `Student.isActive` at send time. That
  send-time guard is what covers the adoption path, roster retirement, and any row written before
  ADR-0033's check existed; it mutates nothing, because revocation belongs to the unlink path and
  a transient roster gap must not delete a subscription.
- `GET /digest/deliveries` scopes on `userId` rather than on subscribed children.
- Unlinking a school deletes the unlinking user's recipient, ledger and delivery rows for every
  child that connection listed, shared ones included — and only that user's.

### Things that stayed, and why

**One model call per child per run, and none at all on some days.** The summarizer never sees
consent forms, so its prose covers only per-child facts, which are identical for both parents; the
summary is memoized per child per run and the forms section uses the deterministic Hebrew line.
Two parents of one child cost one Sonnet call, as before. This also removes consent-form titles
from the prompt altogether, which ADR-0026 would have preferred.

A run whose *only* claims are forms skips the model entirely. With the forms withheld, its prompt
would carry no facts beyond the child's gender and the date, and the model would still be asked for
a headline and four section lines — a headline written from nothing is a headline invented, and
`linesFor` keeps the headline. The deterministic renderer produces the whole message instead, and
the run records `usedLlm: false`.

**The consent-form dedup still ignores `studentGuid`.** A form belongs to the parent, not the
child, so it is mentioned once across their children — but now also once per *parent*, which is
the fix. The `userId` inside the content hash is kept, which is why the migration cannot copy
activity rows between parents.

**Targets are processed strictly sequentially.** This is a correctness requirement, not a style
choice: cross-child form dedup is guaranteed only by the sequential pre-check in
`dropAlreadyReported`, so a `Promise.all` over one parent's children would send the same form
twice.

**A chat two accounts both linked gets one copy of an identical message.** Both rows exist and
each account controls its own; within a run, a byte-identical message to a chat already reached is
suppressed, counted as delivered (the `delivered === 0` guard throws, releases claims and would
retry forever otherwise), and noted in the delivery row. `recipientCount` excludes it, because
that is the field the delivery stats aggregate and a suppression is not a chat reached. The
fingerprint is per (channel, address, child, text): two children whose messages render identically
— two `studentGuid`s for one child, which a re-enrolment or two schools listing them both produce
— are each sent. If the two parents' forms differ the messages differ and both are sent — accepted.

**`ניתוק` takes that parent's ledger but keeps their history.** `TelegramLinkService.disconnect`
deletes the recipient rows, the link codes and this user's `DigestReportedItem` rows for those
children, in one transaction: left behind, a re-link would find every item it had already reported
still in the ledger and say nothing about any of them, so reconnecting would look like it changed
nothing. The delivery rows stay — unlike an unlink, the child and the connection survive here, the
rows are the parent's own run history, and they carry no chat id.

**Unlinking leaves `TelegramLinkCode` alone.** It is link history, nothing delivers off it, the
codes expire in fifteen minutes, and they are pruned after a week.

### Why the migration copies a ledger rather than starting empty

Before this change, one per-child run delivered to *every* enabled recipient of the child. Every
existing subscriber has therefore already received everything in that child's ledger. So the
migration backfills the existing rows to the child's earliest subscriber — who is exactly who the
old code reported forms for and logged deliveries as — and then copies each child's **confirmed,
non-activity** rows to the child's other subscribers.

Without that copy, the second parent's first per-user run would re-report the whole active window
at them: today's behaviour, three days of newly assigned homework, fourteen days of hint-matched
due homework, seven days of consent forms. Activity rows are excluded because their content hash
embeds the owning `userId`, making a copy a row that parent could never compute or match.

Two details that are load-bearing rather than incidental:

- **"Earliest subscriber" means earliest *enabled* subscriber.** That is what the pre-deploy code
  did (`listDeliveryTargets` read `where: { enabled: true }`, then took the earliest `activeFrom`
  among those rows), so it is who the forms in a historic `messageText` belonged to and whose run
  logged it. Ordering over all rows instead would attribute that message to a parent whose chat
  was switched off, who could then read the other parent's message through
  `GET /digest/deliveries` — this change's own leak, applied to history. `enabled` leads the
  `ORDER BY` rather than filtering, so a child whose every chat is off still has an owner.
- **The copy runs once, not on every boot.** `backend/Dockerfile` executes the file on every
  container start, and the copy's justification holds only for the state the deploy inherits: once
  the per-user code is live, a freshly confirmed row belongs to the one parent it was sent to, and
  copying it at the next restart would silence that item for everyone else — exactly the failure
  this change removes. So it is guarded by a marker row in a new `DataBackfill` table. The table
  is declared in `schema.prisma` and not only in the migration because
  `prisma db push --accept-data-loss` **drops a table the schema does not mention**, which would
  reset the marker on every boot; that was verified against Postgres rather than assumed.

The same reasoning applies to the household merge, which repoints a connection to another
`AppUser`: `DigestReportedItem` and `DigestDelivery` now carry a `userId`, so they travel with the
subscription. Leaving them behind would hand the merged household a recipient row with a months-old
`activeFrom` and an empty ledger, and its next run would re-report that same window. The orphan's
colliding ledger rows are deleted first (the dedup unique carries `userId`, so a shared child can
hold a row under both households), by correlated subquery rather than a key list — the ledger is
unbounded, and a list that long would eventually exceed Postgres's bind-parameter limit and break
the merge permanently.

The file has no `DELETE`. A row left at the `userId = ''` default is invisible to every per-user
query and `DigestRetentionService` clears it within ninety days; deleting would be the one
irreversible statement in the file, and would re-blast a backlog at any child whose only recipient
happened to be toggled off when it ran.

## Alternatives Considered

**Keep one run per child; render per recipient.** One model call, one ledger, and the forms section
computed per recipient at send time. Rejected: the dedup ledger is what makes the digest
at-most-once, and a shared ledger cannot answer "has *this* parent been told?" — whichever run
went first silenced the day's items for everybody. The at-most-once guarantee has to be per
reader, or it is not a guarantee about anyone.

**Keep the shared ledger and drop the forms section from the message.** Cheapest fix for the leak,
and it fixes nothing else: the second parent still gets no row of their own, still cannot be
reached after the first parent's run claims the items, and still keeps receiving a shared child
after unlinking.

**Delete unattributable rows in the migration instead of leaving them.** Tidier, and the only
irreversible statement in a file that runs on every boot. A `userId = ''` row costs nothing but
disk for ninety days.

## Consequences

**Positive**

- A parent's digest, dedup state and delivery history are their own: `GET /digest/deliveries`
  cannot surface another household's — or another parent's — rendered message.
- Both parents of a shared child hear the same per-child news, independently, and each sees only
  their own consent forms.
- Unlinking a school stops that parent's digests for the children it listed, immediately, without
  touching the other parent's.
- The send-time ownership guard closes the adoption-path and retired-child leaks that no amount of
  care at subscribe time could.

**Negative / accepted**

- `digest_reported_item` and `digest_delivery` grow by a factor of the number of subscribing
  parents per child. Both are swept by `DigestRetentionService`, and the new indexes
  (`[userId, studentGuid, contentHash]`, `[userId, contentHash]`, `[userId, runAt]`) are what keep
  the hot queries off a full scan.
- A household merge now has to drop the orphan's colliding subscription rather than repoint it.
  The surviving row wins, so the merged-away parent's `activeFrom`/`enabled` for that exact
  (child, chat) tuple is lost; it is a few taps in the wizard to restore.
- **Residual: two concurrent *processes* could still double-report a consent form.** Cross-child
  form dedup rests on the sequential pre-check in `dropAlreadyReported`, not on a constraint —
  the form's unique key includes `studentGuid`, so two runs for two siblings of the same parent can
  both claim it and both mention it. Within one process the in-flight guard and the sequential
  loop prevent it; a second replica of the backend would not be prevented. Per-child items are
  unaffected: their claim is a unique-constraint race the database settles. Fixing it properly
  means a form claim keyed without `studentGuid`, which is a schema change and a migration for a
  deployment that does not run two replicas today.
