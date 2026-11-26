import {
  DigestActivityFact,
  DigestBehaviorFact,
  DigestBoardFact,
  DigestHomeworkFact,
  DigestPayload,
  DigestProse,
  DigestReleaseFact,
  DigestSectionId,
} from './digest.types';
import { clampLine, escapeTelegramHtml } from '../telegram/telegram-html';
import {
  ChildBehaviorFilter,
  ChildSection,
  behaviorItemUrl,
  boardNoticesUrl,
  childSectionUrl,
  childUrl,
  homeworkItemUrl,
} from '../telegram/notify-links';

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
 * So each section header anchors its section and each item line anchors its
 * own detail page, and `studentGuid` reaches this function through
 * `RenderReportOptions` rather than through `DigestPayload`, because that
 * object feeds `buildPrompt` and the PII boundary there is unchanged.
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
  homeworkNew: '📚 שיעורי בית חדשים',
  release: '🕑 שחרור מוקדם',
  activity: '✍️ אישורים שממתינים לך',
  board: '📢 הודעות מלוח המודעות',
  dueTomorrow: '📅 צפי הגשה למחר',
};

const FILES_TITLE = '📎 קבצים';

/**
 * The header's share of the line budget. A first name needs a small fraction
 * of it; the rest of the line is a weekday and a date this module formats.
 */
const HEADER_NAME_BUDGET = 120;

/**
 * Where a section's header points.
 *
 * `'child'` means the child's page with no section selected -- as close as the
 * message can get to something that lives in a dialog. `null` means the
 * section genuinely has no web surface, and a dead header is the honest
 * rendering.
 */
type SectionTarget = { section: ChildSection; behavior?: ChildBehaviorFilter } | 'child' | null;

const SECTION_TARGETS: Record<DigestSectionId, SectionTarget> = {
  behavior: { section: 'behavior', behavior: 'attention' },
  positive: { section: 'behavior', behavior: 'positive' },
  homeworkNew: { section: 'homework' },
  // An early release lives in a dialog with no URL of its own, so the child's
  // page is as close as the message can get -- and closer than nothing, which
  // is what a dead header among six live ones amounts to.
  release: 'child',
  // A consent form has no web surface at all: no route, no section, no dialog.
  // Linking anywhere would take the parent somewhere that cannot answer it.
  activity: null,
  board: { section: 'notices' },
  dueTomorrow: { section: 'homework' },
};

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

  const headline = line(prose.headline);
  if (headline) blocks.push(headline);

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
    const lines = id === 'activity' ? templateOwned : prose.itemLines;
    const intro = id === 'activity' ? '' : prose.intros[id];
    const rendered = section(id, items, lines, intro, base, guid, extraLines);
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
 * One section: a bold title, the intro if it earned its place, then a bullet
 * per item with its own anchor.
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
  base: string | null,
  guid: string | null,
  extraLines: string[],
): string {
  const target = SECTION_TARGETS[id];
  const href =
    target === 'child'
      ? childUrl(base, guid)
      : target
        ? childSectionUrl(base, guid, target.section, target.behavior ?? 'all')
        : null;
  const title = SECTION_TITLES[id];

  // The emoji stays outside the anchor: a marker is not a link, and Telegram
  // renders an anchored emoji as part of the tappable text.
  const [marker, ...words] = title.split(' ');
  const label = words.join(' ');
  const heading = href
    ? `<b>${marker} ${anchor(href, label)}</b>`
    : `<b>${escapeTelegramHtml(title)}</b>`;

  const lines: string[] = [heading];

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

    lines.push(`• ${item.href ? anchor(item.href, clamped) : escapeTelegramHtml(clamped)}`);
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
  // satisfy a `startsWith('• ')` scan and keep an itemless heading alive.
  if (rendered === 0) return '';

  for (const extra of extraLines) {
    const clamped = clampLine(extra);
    if (clamped.length > 0) lines.push(escapeTelegramHtml(clamped));
  }

  return lines.join('\n');
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
    lines.push(`• קובץ גדול מדי לשליחה: ${href ? anchor(href, name) : escapeTelegramHtml(name)}`);
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
  return `<a href="${escapeTelegramHtml(href)}">${escapeTelegramHtml(label)}</a>`;
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
