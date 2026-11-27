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
- `escapeTelegramAttribute` for an `href`. The three reserved characters are
  the reserved set of a *text node*; inside `href="…"` a bare `"` ends the
  attribute mid-URL, and `PUBLIC_BASE_URL`'s validator admits one.
- `stripTelegramHtml`, the fallback payload.

`TelegramSender.send` takes `{ parseMode: 'HTML' }` from a caller that rendered
HTML and **retries that part once as plain text** when Telegram answers with a
parse complaint (`can't parse entities`, `unsupported start tag`, `unclosed`).
`TelegramMediaSender` does the same for captions. The retry is the belt the old
rule used to be: a parse failure must never cost a parent the whole message.

The line between "Telegram refused this" and "the transport failed" is drawn
on whether a **response came back at all**, not on the HTTP status, and that
distinction is the retry's whole load-bearing part: the Bot API reports a parse
error as **HTTP 400**, which axios rejects under its default `validateStatus`.
A sender that treated every rejection as a transport failure had a retry that
could not fire in production while its unit tests — which mocked a resolved
`ok:false`, a shape axios cannot produce for a 400 — passed. `telegramRefusal`
in `telegram-http.ts` owns the distinction for both senders.

Only a parse complaint is retried. A 429, a 502 or a blocked bot stays a
failure, because sending stripped text after one of those would report success
for a message that never arrived — and the digest would then confirm its claims
and bury the day's news permanently, since nothing ever re-reports an item
already in the ledger.

`TELEGRAM_HTML_ENABLED` defaults to `true` and is read by the **sender**, not
by the templates. Templates always emit HTML; with the flag off the sender
sends `stripTelegramHtml(text)` flat — which flattens each anchor to
`label: url` rather than dropping it, so neither the kill switch nor a retry
deletes the deep links this ADR exists to add. One component owns the decision because
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

A mail paragraph is the one value that is wrapped rather than clamped, with
`splitLine`: `INBOX_NOTIFY_BODY_CHARS` is a configurable body budget and may
be set above `TELEGRAM_LINE_BUDGET`, where a clamp would drop the end of a
paragraph the school wrote with nothing in the message to say so. Each part
still obeys the budget on its own, and one `<blockquote>` per part keeps every
tag inside one line.

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
| Section header | **no link** — a header can only point at the section list, which leaves the parent to find the item the message was about |
| Board notice | `/children/<guid>?section=notices&behavior=all` (no detail route exists) |
| Early release | `/children/<guid>` (the item lives in a dialog with no URL, so its bullet points at the child's page) |
| Consent form | **no link** — no web surface at all |
| Mail | `/inbox/<conversationId>` (unchanged) |

The guid's cost was reconsidered rather than dismissed. The chat is one the
parent proved they control ([ADR-0033](0033-parent-driven-telegram-linking.md)'s link wizard); the guid is useless
without a session that owns the child; mail has carried a conversation id all
along. Against that, the old rule charged the parent on every single message:
told that their child had an unexcused absence, they landed on the home page
and had to find the child and the note themselves.

Each item line anchors its own detail page, so the message carries **no bare
URL** and the trailing `/home` line is gone. A section header anchors nothing:
it first did, and a header link turned out to be a worse link than none — it
lands on a list one tap from the thing the parent wants, which is the cost the
item anchors exist to remove, and it made every heading as well as every bullet
blue, trading the wall of grey for a wall of links. `studentGuid` reaches the template through `RenderReportOptions`
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

## Addendum, 2026-11-27: observed, then three corrections

Eight variants were sent to a real chat and read in a real client. Two things
came back, and both are now in the code:

1. **Section headers are no longer links** (above). The reasoning that put
   them there — "a parent told about an absence should not land on /home" — is
   satisfied by the item anchor alone.
2. **The TL;DR answers "by when".** The headline is a summary of the day and
   nothing in the message said when anything had to be handed in, unless it
   happened to be due tomorrow. `submissionSummary` in
   `digest-report.template.ts` now renders one deterministic line under the
   headline — `📌 להגשה: אנגלית — עד 30/11/2026 · חשבון — צפי להגשה 19/11/2026`
   — from two sources, in this order:
   - a date written in the assignment text, which the model extracts into
     `DigestSummary.explicitDueDates` (keyed by the **namespaced** ref, unlike
     `deadlineResolutions`, which strips to the bare id for the deferral ledger
     and therefore has to exclude `homeworkNew` to avoid a collision) — `עד`;
   - the group's next lesson in the timetable — `צפי להגשה`.

   Newly assigned homework now carries that estimate too: the checker resolves
   it for both homework passes through one memoized estimator, so the two
   sections share a single query per group per run, and the collector keys the
   estimate by item **type and** id because one row can be a candidate in both.
   A date earlier than the day being reported is dropped — a wrong-year reading
   of Hebrew text that names no year is the ordinary way one appears, and
   telling a parent to hand something in last week is worse than silence.

   The line is the template's and not the model's, and that is the point.
   Mashov has no due-date field, so `עד` and `צפי להגשה` are two different
   claims about where a date came from, and ADR-0027 is a promise that the
   derived one is always labelled derived. A model writing this sentence cannot
   hold that line, because to it both are just dates; the prompt instead tells
   it that `צפי לפי מערכת השעות` is a calculation and must not be written as a
   deadline.

3. **Every bullet now opens with a RIGHT-TO-LEFT MARK (U+200F).** `•` is a
   direction-neutral character, so a line beginning with one leaves the client
   to resolve which end it belongs to -- and in Telegram's rendering of a
   Hebrew line it landed hard against the **left** margin: the end the eye
   finishes on, not the one it starts from, with the bullet separated from the
   sentence it marks. The section headers did not have the problem, because
   their emoji is resolved differently, which is what made the message look
   inconsistent rather than merely wrong.

   The fix is one invisible strong-RTL character in front of the bullet
   (`BULLET` in `digest-report.template.ts`), not a layout change: it puts the
   bullet inside an RTL run, so it renders on the right. It applies to item
   bullets and to the "file too large" line, and it survives
   `stripTelegramHtml`, so the flat fallback render keeps it too.

## Addendum, 2026-11-27: a grades section the template can already render

`GradeItem` has been synced and stored since the grades task landed, and its
schema comment says plainly that "grades feed no digest and no feed (yet)".
The template now renders them, ahead of anything producing them, so that the
wiring left to do is a checker rule and a collector read rather than a design
decision taken under time pressure.

What exists now:

- `DigestGradeFact` and `DigestPayload.grades`. The fact deliberately omits
  `teacherName` -- the only field of a grade that names a person, of no use to
  the message, and keeping it off the shape is what keeps it out of the prompt
  by construction rather than by discipline.
- The section id `grades`, ordered after `positive` and before `homeworkNew`:
  news about the child, then the work, then the logistics.
- `📊 ציונים חדשים`, one bullet per grade, reading
  `חשבון — מבחן בשברים: 92 (10/11/2026)`.
- The date is `eventDate`, when the assessment was sat, **not** `enteredAt`,
  when the teacher keyed the mark in. They are weeks apart on real rows, so a
  bare "92" would attach a mark to the wrong day in a parent's head. The
  checker will want the opposite field: `enteredAt` is when the grade became
  news.
- `gradeType` ("מבחן") stands in when the assessment has no name of its own,
  which upstream does send.
- `gradesSectionUrl` -- the `grades` tab on the child's page. There is no
  per-grade detail route, so this is the board-notice compromise, and
  `tests/integration/notify-links-routes.test.ts` checks the path against the
  frontend's own patterns like every other link.
- The section is **template-owned**, joining `activity` in `TEMPLATE_OWNED`.
  The reasoning is narrower than ADR-0035's: the model is shown no grades, so
  a model line for one could only be invention. `push` routing the section to
  the deterministic lines is what makes that true of the rendered text and not
  only of the prompt. The day grades enter the prompt, drop `grades` from that
  set.

What does not exist, and is deliberately left for the session that wires it:
no `DigestItemType` member, no checker rule, no collector read -- the collector
returns `grades: []` with a comment saying so. A grade is also the first digest
item that can be **corrected** upstream after it is reported, so the content
hash and the re-report rule are a real decision, not a copy of the homework
one. Until all that lands the section never appears, because an empty list
renders nothing.

## Addendum, 2026-11-27: three fixes out of review

- **One reading of a `YYYY-MM-DD` day** (`src/digest/iso-day.ts`). Three copies
  had grown -- the deferral ledger, the submission summary, and the
  summarizer's validation of the model's answer. Two built the date with
  `new Date('…T00:00:00Z')` and one with `Date.UTC`, which looks like a
  difference and is not: **both roll a day that does not exist silently
  forward**, so `2026-02-30` became 02/03 in all three. The shared parser
  rejects it instead, by checking the parsed date still carries the month and
  day it was written with. A model that answered with a day that is not a day
  has answered nothing, and "March 2nd, because February has 28 days" is not a
  provenance a parent can be told.
- **No empty entities in an inbox notification.** A mail with a blank subject
  rendered a literal `<b></b>`, which Telegram can answer `can't parse
  entities` to -- a wasted call and a flat retry spent on a line that said
  nothing -- and a mail with no sender name opened with a dangling `·`. Both
  lines are now omitted when they are empty rather than rendered hollow.
- **The route drift guard now guards.**
  `tests/integration/notify-links-routes.test.ts` only asserted that each built
  path satisfies `PHASE1_ROUTE_PATTERNS`, which admits `/children/<anything>`
  at any depth -- renaming the frontend's `/homework/` segment to
  `/assignments/` left it green while every homework link in every message
  404s. Verified by making exactly that change and watching the old assertions
  stay green. The paths are now also compared for equality against the
  frontend's own builders.

## Addendum, 2026-11-27: `max_tokens` scales with the day

The ceiling was a flat 4000, sized for the seven fixed lines the model wrote
back when the prose was one paragraph per section. The output is now one short
sentence per **item**, and `parseOutput` is all-or-nothing -- a truncated
response is not valid JSON, so it lands on the deterministic renderer for
*every* item, not just the ones that got cut. A fixed ceiling therefore failed
in exactly the wrong direction: the busier the day, the likelier the parent
got plain bullets for all of it.

`maxTokensFor(payload)` is `2000 + 300 per item`, floored at the old 4000 and
capped at 16000. The floor means no quiet day asks for less than it used to.
The per-item figure is deliberately generous, because Hebrew tokenizes badly
and thinking counts against this ceiling on this model and cannot be turned
off. The cap is there because `max_tokens` is a budget, not a target: one
absurd day -- a backfill, a sync that re-reports a term -- must not buy an
unbounded response. Past the cap the old behaviour resumes, now only at the
far end.

Items the model is not shown are not counted: consent forms (ADR-0035) and,
for now, grades.

