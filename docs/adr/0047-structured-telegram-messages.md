# ADR-0047: Telegram Messages Get HTML, Deep Links, and One Model Line per Item

- **Date**: 2026-11-26
- **Status**: Accepted
- **Deciders**: User, Backend agent
- **Supersedes in part**: [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md), [ADR-0039](0039-mashov-attachments-into-telegram.md), [ADR-0027](0027-derived-homework-deadlines.md) (unchanged, restated)

## Context and Problem Statement

Four kinds of message go out to parents: the daily digest, an attachment
caption, an inbox-mail notification, and a run summary. Every one of them was
plain text, every section title was a bare Hebrew word on its own line, nothing
was bold, nothing was quoted, and the single link went to `/home`. A day with
five sections read as one grey wall.

Three separate decisions produced that, and each was individually sound:

1. **No `parse_mode`, anywhere.** Markdown and MarkdownV2 reject an ENTIRE
   message whose text carries an unbalanced `*` or `_`, or (in V2) any of
   `.-!()`. Teacher remarks, filenames and mail bodies are full of those. A
   rejected digest threw, released its dedup claims, and the next hourly run
   built the same message and failed identically — forever.
2. **Identifier-free links.** A Telegram chat is a shared, forwardable
   artifact, so a `studentGuid` in someone else's hands outlives the message it
   arrived in. Hence `${publicBaseUrl}/home` and nothing more.
3. **No item bullets** (ADR-0026). The report used to print a model-written
   paragraph per section and then list the same facts underneath, which is the
   raw record stapled to a message about it.

Decision 3 had a consequence nobody chose: with the bullets gone, the paragraph
became the *only* place the facts appeared. So the prompt had to order the model
to cram every subject, every exact assignment text, every time and date into one
sentence — "הטקסט שלך הוא המקום היחיד שבו ההורה יראה את הפרטים". Warm
conversational prose and a complete factual record are two incompatible jobs,
and asking for both in one sentence is what read as unpolished. The model was
not performing badly; it was doing two things at once.

Decision 2 was also only half-held: `InboxNotifyService` has always linked to
`/inbox/<conversationId>`.

## Decision

Reverse all three, each with the mechanism that makes the reversal safe.

### 1. HTML parse mode, with an escape boundary and a strip-and-retry

Telegram's HTML parse mode reserves three characters — `&`, `<`, `>` — and not
one of them appears in ordinary Hebrew free text. That makes escaping a
boundary a template can actually hold, rather than a running battle with
punctuation. This is the whole reason HTML is a different bargain from
Markdown, and it is why ADR-0026's and ADR-0039's no-`parse_mode` paragraphs
no longer apply.

`backend/src/telegram/telegram-html.ts` owns three things:

- `escapeTelegramHtml`, applied to **every** interpolated value. Teacher
  remarks, filenames, mail subjects and bodies are untrusted input.
- `clampLine`, which holds the invariant below.
- `stripTelegramHtml`, the fallback payload.

`TelegramSender.send` takes `{ parseMode: 'HTML' }` from a caller that rendered
HTML and **retries that part once as plain text** when Telegram answers with a
parse complaint (`can't parse entities`, `unsupported start tag`, `unclosed`).
`TelegramMediaSender` does the same for captions. The retry is the belt the old
rule used to be: a parse failure must never cost a parent the whole message.

Only a parse complaint is retried. A 429, a 502 or a blocked bot stays a
failure, because sending stripped text after one of those would report success
for a message that never arrived — and the digest would then confirm its claims
and bury the day's news permanently, since nothing ever re-reports an item
already in the ledger.

`TELEGRAM_HTML_ENABLED` defaults to `true` and is read by the **sender**, not
by the templates. Templates always emit HTML; with the flag off the sender
sends `stripTelegramHtml(text)` flat. One component owns the decision because
one component owns the retry, and it makes a parse problem in production a
restart rather than a deploy.

#### The chunking invariant

`chunkTelegramText` cuts at the last blank line, then the last newline, then
hard. The first two are tag-safe; the hard cut is not. The fix is an invariant,
not a smarter chunker:

> **Every tag opens and closes inside one line, and no rendered line approaches
> `TELEGRAM_CHUNK_LIMIT`.**

Templates hold it with `clampLine`, which collapses newlines out of every
interpolated value and caps it at `TELEGRAM_LINE_BUDGET` (900). The budget is
measured **after** escaping: one `&` becomes five characters, so a raw-length
budget of 900 would admit a 4500-character line and defeat the invariant.
Mail bodies were already budgeted by `DEFAULT_BODY_CHARS`.

### 2. Deep links that carry the studentGuid

`backend/src/telegram/notify-links.ts` mirrors `frontend/src/lib/child-routes.ts`
— same shapes, same guid/id normalisation — because the backend cannot import
from `frontend/`. `tests/integration/notify-links-routes.test.ts` asserts the
produced paths against the frontend's own exported `PHASE1_ROUTE_PATTERNS`, so
the two copies cannot drift silently and a parent who follows a link while
signed out lands on the item after the sign-in bounce. That guard has to live
in the integration suite: the unit container is built from `./backend` alone
and has no `frontend/` in its image, while the integration container mounts the
whole repo.

| What | Target |
|---|---|
| Behaviour item | `/children/<guid>/behavior/<id>` |
| Homework item | `/children/<guid>/homework/<id>` |
| Section header | `/children/<guid>?section=<s>&behavior=<f>` |
| Board notice | `/children/<guid>?section=notices&behavior=all` (no detail route exists) |
| Early release | `/children/<guid>` (lives in a dialog, no URL) |
| Consent form | **no link** — no web surface at all |
| Mail | `/inbox/<conversationId>` (unchanged) |

The guid's cost was reconsidered rather than dismissed. The chat is one the
parent proved they control ([ADR-0033](0033-parent-driven-telegram-linking.md)'s link wizard); the guid is useless
without a session that owns the child; mail has carried a conversation id all
along. Against that, the old rule charged the parent on every single message:
told that their child had an unexcused absence, they landed on the home page
and had to find the child and the note themselves.

Each section header anchors its section and each item line anchors its own
detail page, so the message carries **no bare URL** and the trailing `/home`
line is gone. `studentGuid` reaches the template through `RenderReportOptions`
and deliberately **not** through `DigestPayload` — that object feeds
`buildPrompt`, and a guid on it would be one `JSON.stringify` away from the
prompt.

A consent form gets no link because linking anywhere would be a lie: there is
no route, no section and no dialog that can answer one.

### 3. The model writes one line per item; the template lays them out

`DigestProse` replaces `DigestLines`:

```ts
interface DigestProse {
  headline: string;                                 // one line, no date, no name
  intros: Partial<Record<DigestSectionId, string>>; // optional, often absent
  itemLines: Record<string, string>;                // keyed by digestItemRef()
}
```

This is **not** a return to the bullets ADR-0026 removed. Those were the raw
record stapled under a paragraph; these *are* the prose — one model-written
line per thing that happened, which is the grain at which a sentence can be
both short and complete. The "your text is the only place the parent sees the
details" instruction is gone, because it is no longer true and it was the cause
of the blob.

- `digestItemRef(section, id)` is the single place that decides what a ref is,
  so the refs the prompt shows and the refs the renderer looks up cannot drift.
  Namespaced by section because one homework row is reported twice on the day
  it is both newly assigned and estimated-due, and a bare id would make the two
  sections share one sentence.
- `buildPrompt` emits a `ref` for **every** fact, not just homework. These are
  local DB ids and upstream event ids — the class already sent for homework
  before this ADR — so no new identifier leaves the host.
- `deadlineResolutions` folded into `items`: the model answers the deadline
  question once, on the item whose line sits beside it, instead of in a second
  array keyed by the same refs.
- `itemLinesFor` merges the model's lines over the deterministic ones **per
  ref**, keyed off the deterministic map. A line the model skipped costs one
  bullet rather than a section; a line about an item narrowing removed is
  dropped with the item; an invented ref renders nothing. The headline and the
  affected section's intro are still discarded wholesale when narrowing changed
  the set, because both were written about a set that no longer exists.
- A section intro is optional and earns its place only when it says something
  the item lines do not. Blank intros are absent rather than empty, so no blank
  line reaches the chat.
- A teacher's `remark` renders as `<blockquote>`, template-owned, so their
  words are visibly theirs — and so the model never has to carry them and
  cannot drop them. `behaviorSentence` no longer repeats the remark inline.
- The header gains the Hebrew weekday: `יונתן · יום רביעי, 26/11/2025`.
  Deterministic, and the cheapest readability win in the message.
- Emoji markers, one per section: ⚠️ התנהגות ונוכחות · 🌟 חיזוק חיובי ·
  📚 שיעורי בית חדשים · 🕑 שחרור מוקדם · ✍️ אישורים שממתינים לך ·
  📢 הודעות מלוח המודעות · 📅 צפי הגשה למחר · 📎 קבצים.

### What did not change

- **The PII boundary.** `buildPrompt` still forwards no part of the child's
  name, no `studentGuid`, no reporter or teacher name, no username, no release
  remark, and no consent-form title; it still has no `JSON.stringify` shortcut,
  and its spec is still hostile on purpose. ADR-0026 stands on this point.
- **[ADR-0027](0027-derived-homework-deadlines.md)'s promise** that a derived deadline is always labelled derived.
  The `צפי הגשה` label and its date are appended by the template, never left
  to the model.
- **[ADR-0035](0035-per-user-digest-isolation.md)'s** consent section: the model is handed no forms, and the section
  now reads its lines from the deterministic map rather than from the prose, so
  the guarantee holds of the rendered text and not only of the prompt.
- **[ADR-0039](0039-mashov-attachments-into-telegram.md)'s** refusal to use `sendMediaGroup`. Captions carrying a deep link
  do not change the per-file isolation reasoning: only the first item's caption
  renders in a group, and one bad item fails the whole group.
- **Inbox mail stays model-free.** The school wrote the mail; a summary would be
  a second-hand account of something the parent can read verbatim. Only the
  layout changed, and recipients stay absent — they name other families.

## Consequences

**Good.** A message scans in two seconds: a bold marked heading, one line per
item, the teacher's own words quoted. Every anchor opens the behaviour note,
the assignment, the notices list or the mail thread the message is about.
Attachments arrive labelled with the item they came from. A missing model line
now costs one bullet instead of a section's facts.

**Bad.** Three reversals mean three new failure modes, each with a mitigation
that has to keep working: an escaping miss (every value goes through one
function; the retry catches what slips), a drifted route (the spec asserts the
paths against the frontend's own patterns), and a guid in a forwarded chat
(accepted, reasoned above). The two copies of the route builders are real
duplication the language cannot remove.

**Unknown.** Whether per-item lines plus an optional intro reads better than
one paragraph is a judgement about Hebrew prose that only real messages
settle. `TELEGRAM_HTML_ENABLED=false` is the escape hatch if the structure
turns out worse than the wall it replaced.
