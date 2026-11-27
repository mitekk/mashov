import {
  DigestActivityFact,
  DigestBehaviorFact,
  DigestBoardFact,
  DigestGradeFact,
  DigestHomeworkFact,
  DigestPayload,
  DigestProse,
  DigestReleaseFact,
  DigestSectionId,
} from './digest.types';
import {
  clampLine,
  escapeTelegramAttribute,
  escapeTelegramHtml,
} from '../telegram/telegram-html';
import {
  behaviorItemUrl,
  boardNoticesUrl,
  gradesSectionUrl,
  childUrl,
  homeworkItemUrl,
} from '../telegram/notify-links';
import { parseIsoDay } from './iso-day';

/**
 * The fixed Hebrew report, as Telegram HTML.
 *
 * The template owns every structural decision -- which sections exist, which
 * appear, their order, their emoji markers, the estimate label, the unexcused
 * marker and the whole consent section -- and the model writes one short
 * sentence per item plus an optional section intro. Hand it
 * `deterministicProse(payload)` instead and the same message renders with no
 * model involved at all.
 *
 * ## Why there are bullets again
 *
 * ADR-0026 removed item bullets, and it was right to: the report printed a
 * model-written paragraph per section and then listed the same facts
 * underneath, which is the raw record stapled to a message about it. The
 * consequence was that the paragraph became the only place the facts appeared,
 * so the prompt had to order the model to cram every subject, every exact
 * assignment text, every time and date into one sentence -- warm
 * conversational prose AND a complete record, two incompatible jobs. That is
 * what read as unpolished.
 *
 * The bullets here are not that list. They ARE the prose, one model-written
 * line per thing that happened, which is the grain at which a sentence can be
 * both short and complete. See ADR-0047.
 *
 * ## Why the links carry a studentGuid
 *
 * They used not to: the one link was `${publicBaseUrl}/home`, identifier-free
 * because a Telegram chat is forwardable and a guid in someone else's hands
 * outlives the message. That reasoning was already only half-held -- the inbox
 * notifier has always linked to `/inbox/<conversationId>` -- and it cost the
 * parent something on every message: told about an unexcused absence, they
 * landed on the home page and had to find the child and the note themselves.
 * So each item line anchors its own detail page, and `studentGuid` reaches
 * this function through `RenderReportOptions` rather than through
 * `DigestPayload`, because that object feeds `buildPrompt` and the PII
 * boundary there is unchanged.
 *
 * A section HEADER anchors nothing. It used to anchor its section, and that
 * was a worse link than none: it landed the parent on a list and left them to
 * find the item the message was about -- the exact cost the item anchors exist
 * to remove -- while making every heading and every bullet blue, which is the
 * wall of links this feature replaced a wall of grey with.
 *
 * ## The one invariant that makes HTML safe
 *
 * Every tag opens and closes inside one line, and no rendered line approaches
 * `TELEGRAM_CHUNK_LIMIT`. `chunkTelegramText` cuts at the last blank line,
 * then the last newline, then hard -- and only the hard cut can land inside a
 * tag. `clampLine` on every interpolated value is what keeps that cut
 * unreachable, and `escapeTelegramHtml` is what keeps a teacher's `<` from
 * being read as one.
 */

/** Israeli date order, read from UTC fields -- every digest date is UTC midnight. */
export function formatSchoolDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/**
 * "יום שלישי", and "שבת" without the prefix -- which is how Hebrew says it.
 *
 * UTC getters, like `formatSchoolDate`: every digest date is UTC midnight of a
 * Jerusalem calendar day.
 */
const HEBREW_WEEKDAYS = [
  'יום ראשון',
  'יום שני',
  'יום שלישי',
  'יום רביעי',
  'יום חמישי',
  'יום שישי',
  'שבת',
];

export function formatHebrewWeekday(date: Date): string {
  return HEBREW_WEEKDAYS[date.getUTCDay()];
}

/** "11:30:00" is a column value; a parent reads "11:30". */
export function formatTimeOfDay(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * The key one item's line is stored under.
 *
 * Namespaced by section rather than by bare item id, because one homework row
 * is reported twice on the day it is both newly assigned and estimated-due. A
 * bare id would make those two sections share one sentence, so a line written
 * about tomorrow would appear under "new homework". The same applies to the
 * two behaviour sections, which read from one list.
 *
 * `buildPrompt`, `deterministicItemLines` and the renderer all go through this
 * function, which is the point: the refs the model is shown and the refs the
 * template looks up have to be the same strings, and there is one place that
 * decides what they are.
 */
export function digestItemRef(section: DigestSectionId, id: string): string {
  return `${section}:${id}`;
}

/** What the template needs that is neither a fact nor prose. */
export interface RenderReportOptions {
  /**
   * Already validated by `resolvePublicBaseUrl`. Null or absent renders every
   * title and bullet unanchored, which is the point: a base of `undefined`
   * would put "undefined/children/..." in a parent's chat.
   */
  publicBaseUrl?: string | null;
  /**
   * The child the links point at. Deliberately NOT on `DigestPayload`: that
   * object is the summarizer's input and the PII boundary lives there, so a
   * guid on it would be one `JSON.stringify` away from the prompt.
   */
  studentGuid?: string | null;
  /**
   * Files named in the text because they are NOT being uploaded -- too large,
   * or past the per-message cap. Silence would make the report quietly less
   * than the day it describes. Each carries the item it hangs off, so the line
   * can link to the assignment or the note rather than to a page the parent
   * then has to search.
   */
  unsentFiles?: UnsentFile[];
  /**
   * The due dates the model read out of the assignment texts themselves,
   * keyed by `digestItemRef(section, id)` -- ISO `YYYY-MM-DD` strings.
   *
   * Namespaced refs rather than bare homework ids, because one row carries two
   * of them on the day it is both newly assigned and estimated-due, and a bare
   * id would make the two collide. Absent is normal: it is empty whenever the
   * deterministic renderer produced the prose, and the summary then falls back
   * to the timetable estimates alone.
   */
  explicitDueDates?: Record<string, string>;
}

export interface UnsentFile {
  fileName: string;
  itemType: 'homework' | 'behavior';
  itemId: string;
}

/** Emoji first, so the eye finds the section before it reads the words. */
const SECTION_TITLES: Record<DigestSectionId, string> = {
  behavior: '⚠️ התנהגות ונוכחות',
  positive: '🌟 חיזוק חיובי',
  grades: '📊 ציונים חדשים',
  homeworkNew: '📚 שיעורי בית חדשים',
  release: '🕑 שחרור מוקדם',
  activity: '✍️ אישורים שממתינים לך',
  board: '📢 הודעות מלוח המודעות',
  dueTomorrow: '📅 צפי הגשה למחר',
};

/**
 * The sections whose lines the template writes and the model never sees.
 *
 * `activity` is ADR-0035: consent forms belong to the parent rather than to
 * the child, and the prose is shared between a child's parents, so the model
 * is handed none of them. `grades` is here for the narrower reason that
 * nothing shows it a grade yet -- a model line for one could only be
 * invention, and `push` routing the section here is what makes that true of
 * the rendered text and not only of the prompt.
 */
const TEMPLATE_OWNED: ReadonlySet<DigestSectionId> = new Set<DigestSectionId>(['activity', 'grades']);

const FILES_TITLE = '📎 קבצים';

/**
 * The header's share of the line budget. A first name needs a small fraction
 * of it; the rest of the line is a weekday and a date this module formats.
 */
const HEADER_NAME_BUDGET = 120;

/** One rendered item: its line, and optionally the teacher's own words. */
interface ItemBlock {
  ref: string;
  href: string | null;
  remark?: string | null;
}

export function renderReport(
  payload: DigestPayload,
  prose: DigestProse,
  options: RenderReportOptions = {},
): string {
  const base = options.publicBaseUrl ?? null;
  const guid = options.studentGuid ?? null;

  // Who and when first: this is what a parent scans for in a list of Telegram
  // chats, and it is the only place the child's name appears. The weekday is
  // deterministic and the cheapest readability win in the message.
  //
  // Clamped like every other interpolation: the name comes from upstream, and
  // the stated invariant is that NO value escapes the per-line budget -- not
  // "no value whose line happens to carry a tag".
  const blocks: string[] = [
    `${escapeTelegramHtml(clampLine(payload.childFirstName, HEADER_NAME_BUDGET))} · ${formatHebrewWeekday(payload.reportFor)}, ${formatSchoolDate(payload.reportFor)}`,
  ];

  // The TL;DR: the model's one-line summary of the day, and under it the one
  // question the headline could never answer -- what has to be handed in, and
  // by when. That line is deterministic for the same reason the due-tomorrow
  // label is (ADR-0027): the model is forbidden from stating a deadline,
  // because it cannot tell a date the school published from one the timetable
  // implies, and a parent must never be told the second is the first.
  const tldr = [line(prose.headline), submissionSummary(payload, options.explicitDueDates ?? {})]
    .filter((part) => part.length > 0);
  if (tldr.length > 0) blocks.push(tldr.join('\n'));

  // Two sections from one list. `classification` is written by the sync tasks:
  // a note of praise and an unexcused absence must not share a heading that
  // fits neither.
  const attention = payload.behavior.filter((fact) => fact.classification !== 'positive');
  const positive = payload.behavior.filter((fact) => fact.classification === 'positive');

  // The consent section's lines come from here rather than from `prose`, which
  // is what keeps ADR-0035 true of the rendered text and not only of the
  // prompt: the model is handed no consent forms at all, so anything it wrote
  // about them describes nothing.
  const templateOwned = deterministicItemLines(payload);

  const push = (
    id: DigestSectionId,
    items: ItemBlock[],
    extraLines: string[] = [],
  ): void => {
    const lines = TEMPLATE_OWNED.has(id) ? templateOwned : prose.itemLines;
    const intro = TEMPLATE_OWNED.has(id) ? '' : prose.intros[id];
    const rendered = section(id, items, lines, intro, extraLines);
    if (rendered) blocks.push(rendered);
  };

  if (attention.length > 0) {
    push(
      'behavior',
      attention.map((fact) => behaviorBlock('behavior', fact, base, guid)),
      [unexcusedMarker(attention)],
    );
  }

  if (positive.length > 0) {
    push('positive', positive.map((fact) => behaviorBlock('positive', fact, base, guid)));
  }

  if (payload.grades.length > 0) {
    // Template-owned for now, like the consent section: the model is handed no
    // grades at all, so anything it wrote about one would describe nothing.
    // The day grades enter the prompt, drop 'grades' from TEMPLATE_OWNED.
    push(
      'grades',
      payload.grades.map((fact) => ({
        ref: digestItemRef('grades', fact.id),
        href: gradesSectionUrl(base, guid),
      })),
    );
  }

  if (payload.homeworkNew.length > 0) {
    push('homeworkNew', payload.homeworkNew.map((fact) => homeworkBlock('homeworkNew', fact, base, guid)));
  }

  if (payload.releases.length > 0) {
    push(
      'release',
      payload.releases.map((fact) => ({
        ref: digestItemRef('release', fact.id),
        href: childUrl(base, guid),
      })),
    );
  }

  if (payload.activities.length > 0) {
    // Template-owned end to end (ADR-0035): `push` routes this section to
    // `templateOwned` and gives it no intro.
    push(
      'activity',
      payload.activities.map((fact) => ({ ref: digestItemRef('activity', fact.id), href: null })),
    );
  }

  if (payload.board.length > 0) {
    push(
      'board',
      payload.board.map((fact) => ({
        ref: digestItemRef('board', fact.id),
        href: boardNoticesUrl(base, guid),
      })),
    );
  }

  if (payload.homeworkDueTomorrow.length > 0) {
    // The one fact the model is not trusted to carry, and the only thing
    // marking this date as derived. ADR-0027 is a promise that a derived
    // deadline is always labelled as derived, so the label and the date are
    // appended by the template rather than hoped for in the prose -- and the
    // date is safe to state once, because narrowing has already reduced this
    // section to the items whose estimate is tomorrow.
    const estimate = payload.homeworkDueTomorrow[0].estimatedDueDate;
    const label = estimate ? `צפי הגשה: ${formatSchoolDate(estimate)}` : 'צפי הגשה: מחר';
    push(
      'dueTomorrow',
      payload.homeworkDueTomorrow.map((fact) => homeworkBlock('dueTomorrow', fact, base, guid)),
      [label],
    );
  }

  const files = renderFiles(options.unsentFiles ?? [], base, guid);
  if (files) blocks.push(files);

  return blocks.filter((block) => block.length > 0).join('\n\n');
}

/**
 * One section: a bold, unanchored title, the intro if it earned its place,
 * then a bullet per item with its own anchor.
 *
 * `itemLines` and `introText` are passed in rather than read off the prose, so
 * the caller can route the consent section to the template's own lines --
 * which is what keeps ADR-0035 true of the rendered text and not only of the
 * prompt.
 */
function section(
  id: DigestSectionId,
  items: ItemBlock[],
  itemLines: Record<string, string>,
  introText: string | null | undefined,
  extraLines: string[],
): string {
  // Bold, and never a link. A header could only ever point at the section
  // list, which is one tap away from the item the parent actually wants and
  // leaves them to find it; the item's own bullet is the link that answers the
  // message. See ADR-0047.
  const lines: string[] = [`<b>${escapeTelegramHtml(SECTION_TITLES[id])}</b>`];

  // The caller passes '' for the consent section: nothing the model wrote
  // about it describes anything it was shown.
  const intro = line(introText);
  if (intro) lines.push(intro);

  let rendered = 0;

  for (const item of items) {
    const text = itemLines[item.ref];
    const clamped = clampLine(typeof text === 'string' ? text : '');
    // An item that exists and has no line is skipped rather than rendered as a
    // blank bullet -- but the caller is what guarantees there is a line at
    // all, by merging the model's over the deterministic ones per ref.
    if (clamped.length === 0) continue;

    lines.push(`${BULLET}${item.href ? anchor(item.href, clamped) : escapeTelegramHtml(clamped)}`);
    rendered += 1;

    // The teacher's own words, visibly theirs, and the template's to render --
    // so the model never has to carry them and cannot drop them.
    const remark = clampLine(item.remark ?? '');
    if (remark.length > 0) {
      lines.push(`<blockquote>${escapeTelegramHtml(remark)}</blockquote>`);
    }
  }

  // A section whose every item lost its line is not a section. Counted rather
  // than detected: a model intro that happens to open with a bullet would
  // satisfy a `startsWith(BULLET)` scan and keep an itemless heading alive.
  if (rendered === 0) return '';

  for (const extra of extraLines) {
    const clamped = clampLine(extra);
    if (clamped.length > 0) lines.push(escapeTelegramHtml(clamped));
  }

  return lines.join('\n');
}

/**
 * "What has to be handed in, and by when" -- the one question a parent asks
 * the message, on one deterministic line in the TL;DR.
 *
 * Two sources, in this order of trust:
 *
 * 1. a date written in the assignment text itself, which the model extracted
 *    into `explicitDueDates` (`עד <date>`); and
 * 2. the next lesson of that group in the timetable (`צפי להגשה <date>`).
 *
 * The labels are not interchangeable and the distinction is the whole reason
 * this line is the template's rather than the model's. Mashov has no due-date
 * field: the second date is arithmetic over a timetable, and ADR-0027 is a
 * promise that such a date is always labelled as derived. A model asked to
 * write this sentence cannot hold that line, because to it both dates are just
 * dates.
 *
 * A date earlier than the day being reported is dropped. A wrong-year reading
 * of Hebrew text that names no year is the ordinary way one appears, and
 * telling a parent to hand something in last week is worse than saying nothing.
 */
const SUBMISSION_PREFIX = '📌 להגשה:';

/**
 * The bullet, preceded by a RIGHT-TO-LEFT MARK.
 *
 * `•` is a direction-neutral character, so a line that opens with one leaves
 * the client to guess which end it belongs to -- and Telegram guesses wrong on
 * a Hebrew line, rendering the bullet hard against the LEFT margin, the end
 * the eye finishes on rather than the one it starts from. The RLM is a strong
 * RTL character with no glyph of its own: it makes the bullet part of an RTL
 * run, which puts it on the right, where the sentence begins. It survives
 * `stripTelegramHtml`, so the flat fallback render keeps it too.
 */
const BULLET = '\u200F\u2022 ';

function submissionSummary(payload: DigestPayload, explicit: Record<string, string>): string {
  const entries: string[] = [];
  const seen = new Set<string>();

  const consider = (section: DigestSectionId, fact: DigestHomeworkFact): void => {
    const stated = parseIsoDay(explicit[digestItemRef(section, fact.id)]);
    const due = stated ?? fact.estimatedDueDate ?? null;
    if (!due) return;
    if (due.getTime() < payload.reportFor.getTime()) return;

    const subject = fact.subjectName.trim();
    if (subject.length === 0) return;

    const when = stated
      ? `עד ${formatSchoolDate(due)}`
      : `צפי להגשה ${formatSchoolDate(due)}`;
    const entry = `${subject} — ${when}`;
    // Deduped on what is rendered, not on the ref. One homework row carries
    // two refs on the day it is both newly assigned and estimated-due, and
    // two assignments in one subject due on one day are one errand to a
    // parent -- in both cases the second entry adds a repetition, not a fact.
    if (seen.has(entry)) return;
    seen.add(entry);
    entries.push(entry);
  };

  for (const fact of payload.homeworkNew) consider('homeworkNew', fact);
  for (const fact of payload.homeworkDueTomorrow) consider('dueTomorrow', fact);

  if (entries.length === 0) return '';

  // Clamped and escaped exactly once, as one line: the subject names are
  // upstream text, and the budget is what keeps the chunker's hard cut away
  // from the tags around this block.
  return escapeTelegramHtml(clampLine(`${SUBMISSION_PREFIX} ${entries.join(' · ')}`));
}

/**
 * The files the message is naming because it is not sending them.
 *
 * The link goes to the item that holds the file, not to a home page: the
 * parent wants the assignment the attachment hangs off.
 */
function renderFiles(files: UnsentFile[], base: string | null, guid: string | null): string {
  if (files.length === 0) return '';

  const lines = [`<b>${escapeTelegramHtml(FILES_TITLE)}</b>`];
  for (const file of files) {
    const name = clampLine(file.fileName);
    if (name.length === 0) continue;
    const href =
      file.itemType === 'homework'
        ? homeworkItemUrl(base, guid, file.itemId)
        : behaviorItemUrl(base, guid, file.itemId);
    lines.push(`${BULLET}קובץ גדול מדי לשליחה: ${href ? anchor(href, name) : escapeTelegramHtml(name)}`);
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * An anchor whose label is escaped and whose href is too.
 *
 * The href needs it for one character: a section link carries `&` between its
 * two query params, and an unescaped `&` inside an attribute is what Telegram
 * refuses to parse.
 */
function anchor(href: string, label: string): string {
  return `<a href="${escapeTelegramAttribute(href)}">${escapeTelegramHtml(label)}</a>`;
}

/** One escaped, clamped, single line -- or '' when there was nothing to say. */
function line(raw: string | null | undefined): string {
  const clamped = clampLine(raw ?? '');
  return clamped.length === 0 ? '' : escapeTelegramHtml(clamped);
}

function behaviorBlock(
  id: DigestSectionId,
  fact: DigestBehaviorFact,
  base: string | null,
  guid: string | null,
): ItemBlock {
  return {
    ref: digestItemRef(id, fact.id),
    href: behaviorItemUrl(base, guid, fact.id),
    remark: fact.remark,
  };
}

function homeworkBlock(
  id: DigestSectionId,
  fact: DigestHomeworkFact,
  base: string | null,
  guid: string | null,
): ItemBlock {
  return {
    ref: digestItemRef(id, fact.id),
    href: homeworkItemUrl(base, guid, fact.id),
    // Quoted like a behaviour remark, and for a stronger reason: the prompt
    // tells the model the teacher's note is rendered separately and not to
    // repeat it, so if nothing rendered a homework remark it would be
    // instructed away and lost. "להביא מחברת" is routinely the actionable half
    // of the assignment.
    remark: fact.remark,
  };
}

/**
 * The prose used when the model times out, refuses, or returns unusable output
 * -- and, per ITEM, whenever it returns nothing for an item that exists.
 *
 * Per item rather than per section is the whole improvement: a missing line
 * now costs one bullet rather than a whole section's worth of facts.
 */
export function deterministicProse(payload: DigestPayload): DigestProse {
  return {
    headline: 'עדכון יומי מבית הספר',
    // The model's job, and it has no opinion here. An empty record renders no
    // intro lines at all, which is the right default: the item lines say it.
    intros: {},
    itemLines: deterministicItemLines(payload),
  };
}

/**
 * One plain Hebrew sentence per item, keyed by its ref.
 *
 * Plainer than the model's lines and complete, which is the right trade when
 * the alternative is a parent told that something happened and never what.
 */
export function deterministicItemLines(payload: DigestPayload): Record<string, string> {
  const lines: Record<string, string> = {};

  for (const fact of payload.behavior) {
    const id: DigestSectionId = fact.classification === 'positive' ? 'positive' : 'behavior';
    lines[digestItemRef(id, fact.id)] = behaviorSentence(fact);
  }
  for (const fact of payload.homeworkNew) {
    lines[digestItemRef('homeworkNew', fact.id)] = homeworkSentence(fact);
  }
  for (const fact of payload.homeworkDueTomorrow) {
    lines[digestItemRef('dueTomorrow', fact.id)] = homeworkSentence(fact);
  }
  for (const fact of payload.releases) {
    lines[digestItemRef('release', fact.id)] = releaseSentence(fact);
  }
  for (const fact of payload.activities) {
    lines[digestItemRef('activity', fact.id)] = activitySentence(fact);
  }
  for (const fact of payload.board) {
    lines[digestItemRef('board', fact.id)] = boardSentence(fact);
  }
  for (const fact of payload.grades) {
    lines[digestItemRef('grades', fact.id)] = gradeSentence(fact);
  }

  return lines;
}

/**
 * Names the events the school does not count as excusing themselves.
 *
 * The template's, not the model's -- the same reasoning as the צפי label.
 * Whether an absence was excused changes what a parent does next, so it must
 * not depend on whether the prose happened to mention it.
 *
 * `justifiable` is the school's own policy for the event's code, read from
 * BehaviorTypeReference by the sync tasks. It defaults to false when that
 * school's achvas have not synced yet, so the marker can over-report on a
 * fresh deployment -- which is the safe direction.
 */
function unexcusedMarker(attention: DigestBehaviorFact[]): string {
  const unexcused = attention.filter((fact) => fact.justifiable === false);
  if (unexcused.length === 0) return '';

  const named = unexcused
    .map((fact) => [fact.achvaName, fact.subject].filter((part) => part && part.length > 0).join(' ב'))
    .join('; ');
  return `לא מוצדק: ${named}.`;
}

/**
 * The notice's own words.
 *
 * The expiry date is not printed -- `expirationDate` is when the school takes
 * the notice down, which is rarely the date the notice is about, and printing
 * it as a deadline would be a promise nobody made.
 */
function boardSentence(fact: DigestBoardFact): string {
  const text = fact.text.trim().replace(/\s*\n\s*/g, ' ');
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * The event, and deliberately NOT its remark.
 *
 * The remark is rendered by the template as a `<blockquote>` under this line,
 * so repeating it here would print the teacher's words twice. It moved out of
 * the sentence rather than out of the message.
 */
function behaviorSentence(fact: DigestBehaviorFact): string {
  const head = [fact.achvaName, fact.subject].filter((part) => part && part.length > 0).join(' ב');
  return `נרשם ${head}.`;
}

/**
 * The assignment, and deliberately NOT its remark.
 *
 * Same reasoning as `behaviorSentence`: the template quotes the remark as a
 * `<blockquote>` under this line, so repeating it here would print the
 * teacher's words twice.
 */
function homeworkSentence(fact: DigestHomeworkFact): string {
  return `${fact.subjectName} — ${fact.homeworkText.trim()}`;
}

/**
 * Day and time, and deliberately not the parent's `remark`.
 *
 * The remark is the one other place the child's name appeared in the message
 * ("אבקש לשחרר את יונתן"), and it is text the parent wrote themselves, so
 * leaving it out costs them nothing they did not already know.
 */
function releaseSentence(fact: DigestReleaseFact): string {
  return `שחרור מוקדם ב-${formatSchoolDate(fact.releaseDate)} בשעה ${formatTimeOfDay(fact.startHour)}.`;
}

/**
 * The form's title and its answer deadline.
 *
 * The title falls back to a generic Hebrew noun when it is blank. This is the
 * only per-fact sentence that could come back empty -- every other one emits
 * fixed scaffolding -- and `section()` skips an item with no line, so a blank
 * title would drop the form from the message while the ledger still recorded
 * it as reported. Nothing ever re-reports an item already in the ledger, so
 * that form would never be mentioned again.
 */
function activitySentence(fact: DigestActivityFact): string {
  const title = fact.title.trim() || 'אישור שממתין לתשובתך';
  // The deadline clause is dropped when there is no deadline, rather than
  // printed as a formatted null.
  if (!fact.endAnswerDate) return title;
  return `${title} (יש להשיב עד ${formatSchoolDate(fact.endAnswerDate)})`;
}

/**
 * The subject, which assessment it was, the mark, and the day it was sat.
 *
 * The date is the point of the parenthesis: `eventDate` and `enteredAt` can be
 * weeks apart, so a mark that arrives today routinely belongs to a test from
 * last month, and "92" on its own would attach it to the wrong day in a
 * parent's head.
 *
 * `gradeType` ("מבחן") stands in when the assessment has no name of its own,
 * which upstream does send. The mark is printed via a template literal rather
 * than tested for truthiness anywhere: 0 is a real grade, and the row a parent
 * most needs is the one a falsy check would drop.
 */
function gradeSentence(fact: DigestGradeFact): string {
  const what = fact.gradingEvent.trim() || fact.gradeType.trim();
  const head = [fact.subjectName.trim(), what].filter((part) => part.length > 0).join(' — ');
  const mark = head.length > 0 ? `${head}: ${fact.grade}` : `ציון: ${fact.grade}`;
  return `${mark} (${formatSchoolDate(fact.eventDate)})`;
}
