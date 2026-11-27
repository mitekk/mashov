# Refining the Telegram notifications

## Context

Four message kinds go out to parents today, and all of them are deliberately plain:
`parse_mode` is absent from every send path (`digest/senders/telegram.sender.ts:72-101`,
`telegram/telegram-media.sender.ts:114-116`), because Markdown rejects a whole message over
an unbalanced `*` or `.` and teacher free text is full of both.

Decisions already taken by the user: plain guid in the URL; HTML parse mode with escaping;
per-item model lines plus a section intro; inbox mail stays model-free.

## Phase 1 — HTML as the transport, safely

New `backend/src/telegram/telegram-html.ts`:

- `escapeTelegramHtml(text)` — replaces `&`, `<`, `>` only.
- `stripTelegramHtml(html)` — tags out, the three entities back to characters.
- `TELEGRAM_LINE_BUDGET` and `clampLine(text, budget)`.

Change `TelegramSender.send` to take an optional `{ parseMode }`, send `parse_mode: 'HTML'`
when enabled, and retry once as plain text when Telegram answers `ok: false` with a parse
complaint (`can't parse entities`, `unsupported start tag`, `unclosed`). The retry sends
`stripTelegramHtml(text)`, is not a permanent failure, and does not release the digest's
claims. `TelegramMediaSender` gets the same treatment for captions.

Add `TELEGRAM_HTML_ENABLED` (default `true`) to `docker-compose.yml`, `.env.example` and the
README env table.

**Chunking.** Invariant: every tag opens and closes inside one line, and no rendered line
exceeds the chunk limit. Templates enforce it with `clampLine` (item lines ~900-char budget).
Add one test asserting no line of a maximal rendered message exceeds `TELEGRAM_CHUNK_LIMIT`,
and one asserting a hard cut of a line-free string still yields parseable parts.

## Phase 2 — Deep links to the source

New `backend/src/telegram/notify-links.ts`, mirroring `frontend/src/lib/child-routes.ts`:

| What | Target |
|---|---|
| Behaviour item | `/children/<guid>/behavior/<BehaviorItem.id>` |
| Homework item | `/children/<guid>/homework/<HomeworkItem.id>` |
| Board notice | `/children/<guid>?section=notices&behavior=all` |
| Early release | `/children/<guid>` |
| Consent form | *no link* |
| Mail | `/inbox/<conversationId>` |

Each section header becomes the anchor for its section link, each item line anchors its own
detail link; no bare URLs, the trailing `/home` line goes away. The "file too large" line
links to the item that holds the file.

## Phase 3 — The agent writes lines, the template lays them out

`digest.types.ts`: replace `DigestLines` with

```ts
export interface DigestProse {
  headline: string;
  intros: Partial<Record<DigestSectionId, string>>;
  itemLines: Record<string, string>;
}
```

`digest-summarizer.service.ts`:
- `OUTPUT_SCHEMA` becomes `{ headline, intros{...}, items: [{ ref, line, explicitDueDate }] }`.
  `deadlineResolutions` folds into `items`.
- `buildPrompt` emits `ref: <id>` for every fact (`behaviorForPrompt`, `boardForPrompt`,
  `releaseForPrompt` gain it). PII boundary unchanged: no name, no studentGuid, no reporter,
  no release remark, no consent-form title, no `JSON.stringify` shortcut. Hostile spec stays
  and gets a case for the new refs.
- `SYSTEM_PROMPT` rewritten: one short sentence per item, naming that item's own concrete
  details and nothing else; optional section intro only when it adds something; headline is a
  one-line summary of the day with no date and no name. Drop the "your text is the only place
  the parent sees the details" instruction. Keep gender rule, no-name rule, no-invention rule,
  attention/praise split, never-promise-a-deadline rule.
- `parseOutput` validates the new shape; failure lands on the deterministic renderer.

`digest-report.template.ts`:
- `deterministicLines` → `deterministicItemLines(payload)` returning a per-ref map from the
  existing per-fact sentence helpers (`behaviorSentence`, `homeworkSentence`,
  `releaseSentence`, `boardSentence`, `activitySentence`).
- `renderReport` renders per section: `<b>emoji title</b>` (anchored where a link exists), the
  intro if non-empty, then one `• ` line per item with its own anchor. Template-owned facts
  stay template-owned: `צפי הגשה` label, `unexcusedMarker`, whole consent section.
- Header line gains the Hebrew weekday — `יונתן · יום רביעי, 26/11/2025`.
- A teacher's `remark` renders as `<blockquote>`.
- Emoji markers: ⚠️ התנהגות ונוכחות · 🌟 חיזוק חיובי · 📚 שיעורי בית חדשים · 🕑 שחרור מוקדם ·
  ✍️ אישורים שממתינים לך · 📢 הודעות מלוח המודעות · 📅 צפי הגשה למחר · 📎 קבצים.

`digest.service.ts`: `linesFor` becomes `itemLinesFor`, merging model lines over deterministic
ones per ref. Keep the refusal to render a blank line for an item that exists. The
`renderReport` call passes the new prose object.

## Phase 4 — Attachments that say what they are

- Digest caption: `📎 <fileName>` + the subject or event type it came from + a link to that
  item, instead of the bare filename.
- Inbox caption: keep `fileName — subject`, add the conversation link.
- Both go through `escapeTelegramHtml` + `truncateCaption`.
- `sendMediaGroup` stays unused.

## Phase 5 — Inbox mail: structure only, no model

`inbox-notify.template.ts`, same HTML treatment: `📬 <b>דואר חדש מבית הספר</b>`, sender · time
as an italic meta line, `<b>subject</b>`, the stripped body in `<blockquote>`, named
attachments, and the link anchored on text ("לפתוח את ההודעה"). `renderInboxSummary` gets the
same. Recipients stay absent.

## Docs

One ADR, `docs/adr/0047-structured-telegram-messages.md`, recording three reversals with
reasons: HTML parse mode with an escape boundary and strip-and-retry fallback (supersedes the
no-parse-mode paragraph of ADR-0026 and ADR-0039); guid-bearing deep links (supersedes the
identifier-free paragraph of `digest-report.template.ts:119-128` and ADR-0026); the model
writing per-item lines rather than per-section prose (supersedes ADR-0026's "no item
bullets"). Add the index line in `docs/adr/README.md`.

## Verification

1. `npm run lint` — backend and frontend.
2. `npm run test:unit`. Specs asserting the old decisions get inverted deliberately, not
   deleted: `telegram.sender.spec.ts`, `digest-report.template.spec.ts`,
   `digest-summarizer.service.spec.ts`, `inbox-notify.template.spec.ts`,
   `telegram-media.sender.spec.ts`.
3. `npm run test:integration` — `tests/integration/digest.test.ts` and `inbox-notify.test.ts`.
4. Real render, no sending: `DIGEST_DRY_RUN=true`, `POST /digest/runs`, read `LogSender`
   output plus stored `digest_delivery.messageText`.
5. Real send to the user's own linked chat with `DIGEST_DRY_RUN=false` for one child.
6. Deliberate break: a remark containing `<b>` and `&` must arrive visible and escaped; with
   `TELEGRAM_HTML_ENABLED=false` the same message must still send flat.
