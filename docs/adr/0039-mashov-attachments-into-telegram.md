# ADR-0039: Mashov Attachment Bytes Leave the Host, into a Telegram Chat

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent

## Context and Problem Statement

A school's letter *is* the attachment. The mail body says "see attached"; the homework row says
"the worksheet is attached"; the behaviour note has a scanned page stapled to it. Until now a
parent reading a Telegram message had to leave it, open the site, sign in, and find the item to
see the thing the message was about.

This ADR exists because closing that gap opens a new **direction** of egress, not just a new
field. ADR-0026 established that free text — teacher remarks, homework text, a child's
grammatical gender — crosses the boundary to Anthropic and Telegram unredacted. This goes
materially further.

## Decision

**Attachments on inbox mail, homework items and behaviour items are uploaded into the parent's
Telegram chat, after the text message that describes them.**

**What now leaves the host, stated plainly.** Full attachment bytes. Not a summary, not an
extract — the file. A scanned letter from a school office can name other children, other
parents, staff, medical details and a class list, and nothing in this system reads it before
sending it. ADR-0026's caveat was "free text passes through unredacted"; this is a strict and
significant widening of it. The mitigation is not technical: the recipient is a chat the parent
proved they control (ADR-0033), the feature is gated behind the same master switches, and
`digest_delivery.messageText` records what text went out. There is no content inspection and
none is planned.

**Its own module, `backend/src/telegram-media/`, behind interface tokens.**

A class that downloads from Mashov *and* sends to Telegram would import `MashovSessionModule`,
which `DigestModule`'s docblock and ADR-0026 forbid in that graph: ADR-0023's egress hop is a
single residential tinyproxy meant only for Mashov, `HTTPS_PROXY` is process-wide, and a
parent's message must never traverse it. So the media work lives apart, the module is
`@Global()`, and the digest and the notifier depend on `MEDIA_DELIVERY` — injected
`@Optional()`, so `digest.module.spec.ts` can still compile `DigestModule` alone and assert the
Mashov client is unreachable from it.

The module holds a second token for the same reason, `UPSTREAM_MAIL` (see ADR-0038): a mail
attachment cannot be forwarded at all until the conversation detail has been fetched, because
`MailInboxTask` stores message metadata only and `mail_message.files` defaults to `[]`. Both
tokens are the Mashov-touching work the push features need and may not do themselves, and both
are gated by `TELEGRAM_MEDIA_ENABLED`.

**The downloads go through `MailService` and `ChildrenService`, not the Mashov client.**

Their fourth argument is **not** a session — it is an `AppUser.id`, used for visibility
(`requireStudent`, `assertVisible`, `canSee`) and to scope the credential fallback. The
credentials themselves are decrypted from `HouseholdConnection` and `MashovSessionService` logs
in by itself. So the cron passes the `DigestRecipient`'s `userId` and needs nothing it does not
already hold — and a download for a child the parent has since unlinked still throws. There is
deliberately **no** "system" overload and no bypass: those checks are the only thing standing
between a cron and another household's file.

**`sendPhoto` for small jpeg and png, `sendDocument` for everything else.**

A narrow allow-list, not `startsWith('image/')`. `sendPhoto` previews inline, which is the whole
point — but it re-encodes and downscales, so a scanned permission slip comes out unreadable, and
it refuses a non-image opaquely. gif, svg, heic, webp, tiff and unknown types are documents; a
PDF previews natively as one anyway.

**Download, then render the text, then send the text, then send the files.**

No size is known anywhere until the bytes arrive — there is no size column in this schema — and
the text has to name the file it is *not* sending, or the message is quietly less than the mail
it describes. The text goes before the files because it is the only thing gating ledger
confirmation.

**Nothing in the media path throws.** Each file has its own `try`/`catch`; every failure — a
lost attachment, an oversize one, a 429, the per-message cap, the byte budget — becomes a note
that rides on the delivery row's `errorMessage`. A failed attachment can neither fail nor
re-queue the text message.

**`sendMediaGroup` is deferred.** Only the first caption renders and one bad item fails the whole
group, which is the opposite of the per-file isolation above.

**The attachment metadata does not enter `DigestPayload`.** That object feeds `buildPrompt`,
which is the PII boundary, and a behaviour row's `rawPayload` carries the reporter's name, the
child's guid and the raw remark — `digest-collector.service.spec.ts` asserts the behaviour read
selects no `rawPayload` precisely so it cannot creep back. `DigestAttachmentResolver` takes its
own narrow reads instead, selecting the id column and the attachment column and nothing else.

## Consequences

**Good.** The parent opens the letter where they read about it. The feature is on by default
(`TELEGRAM_MEDIA_ENABLED=true`) because it was asked for, and every caller is still gated by
`DIGEST_ENABLED` / `INBOX_NOTIFY_ENABLED`, both off by default. Four bounds keep it from
becoming an egress firehose: files per message (3), bytes per download batch (50 MB), bytes per
file (20 MB, well inside Telegram's 50 MB document ceiling), and a 1.1s pace between uploads
because Telegram allows roughly one message per second per chat.

**Bad, and the reason this ADR exists.** Attachment bytes are the most sensitive thing this
project has ever sent anywhere, and they go to a consumer messaging service with no content
inspection, no redaction and no per-file consent. A parent who did not realise their chat would
receive scanned school correspondence has not been asked.

**Memory.** The bytes are buffered between download and upload. `MEDIA_TOTAL_BYTES_PER_RUN`
bounds one batch; it is checked before each download and spent after, so it can overshoot by at
most one file, which `TELEGRAM_MEDIA_MAX_BYTES` bounds in turn. This cron is now the one thing
in the process that can move its memory profile.

**Timeouts.** `createMashovAxios` bounds every request with `timeout: 10s` *and*
`signal ??= AbortSignal.timeout(10s)`, with no retry-on-abort. A multi-megabyte PDF over the
residential hop exceeds that, so a per-download override threads **both** values through.
Overriding only one leaves the other cutting the request short, which is why
`downloadTimeoutConfig` is a single pure function.

**Volume.** The digest now sends N+1 messages per child per day: text first, files after. A
household with three children and an attachment each receives six messages where it used to
receive three. A daily cap remains the obvious next refinement, as ADR-0026 already noted for
the text alone.

**No reverse direction.** Nothing here lets a parent send a file *to* the school through
Telegram, and the bot ignores every update except the linking `START` (ADR-0033).
