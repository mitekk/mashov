import {
  DigestActivityFact,
  DigestBehaviorFact,
  DigestBoardFact,
  DigestHomeworkFact,
  DigestLines,
  DigestPayload,
  DigestReleaseFact,
} from './digest.types';

/**
 * The fixed Hebrew report.
 *
 * The template owns every structural decision -- which sections exist, which
 * appear, and the estimate label -- and the prose inside them is
 * written per section. Hand it `deterministicLines(payload)` instead and the
 * same message renders with no model involved at all.
 *
 * There are deliberately **no item bullets**. The report used to print the
 * prose and then list the same facts underneath, which is the raw record
 * stapled to a message about it. One consequence is worth stating plainly: the
 * prose is now the only place the facts appear, so a section's line has to
 * actually say what happened. That is why `deterministicLines` describes
 * rather than counts, and why `DigestService.linesFor` refuses a blank line
 * for a section that has items.
 */

/** Israeli date order, read from UTC fields -- every digest date is UTC midnight. */
export function formatSchoolDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/** "11:30:00" is a column value; a parent reads "11:30". */
export function formatTimeOfDay(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** What the template needs that is neither a fact nor prose. */
export interface RenderReportOptions {
  /**
   * Already validated by `resolvePublicBaseUrl`. Null or absent renders no
   * link line at all, which is the point: a base of `undefined` would put
   * "undefined/home" in a parent's chat.
   */
  publicBaseUrl?: string | null;
  /**
   * Files named in the text because they are NOT being uploaded -- too large,
   * or past the per-message cap. Silence would make the report quietly less
   * than the day it describes.
   */
  unsentFileNames?: string[];
}

export function renderReport(
  payload: DigestPayload,
  lines: DigestLines,
  options: RenderReportOptions = {},
): string {
  // Who and when first: this is what a parent scans for in a list of Telegram
  // chats, and it is the only place the child's name appears.
  const blocks: string[] = [
    `${payload.childFirstName} · ${formatSchoolDate(payload.reportFor)}`,
    lines.headline.trim(),
  ];

  // Two sections from one list. `classification` is written by the sync tasks
  // and has always been in the payload; until now nothing rendered it, so a
  // note of praise and an unexcused absence both read "נרשם ...".
  const attention = payload.behavior.filter((fact) => fact.classification !== 'positive');
  const positive = payload.behavior.filter((fact) => fact.classification === 'positive');

  if (attention.length > 0) {
    blocks.push(
      section('התנהגות ונוכחות', [lines.behaviorLine, unexcusedMarker(attention)]
        .filter((part) => part.trim().length > 0)
        .join('\n')),
    );
  }

  if (positive.length > 0) {
    blocks.push(section('חיזוק חיובי', lines.positiveLine));
  }

  if (payload.homeworkNew.length > 0) {
    blocks.push(section('שיעורי בית חדשים', lines.homeworkLine));
  }

  // Before homework: a child leaving at 11:30 changes the shape of the day in a
  // way that an exercise on page 42 does not.
  if (payload.releases.length > 0) {
    blocks.push(section('שחרור מוקדם', lines.releaseLine));
  }

  if (payload.activities.length > 0) {
    blocks.push(section('אישורים שממתינים לך', lines.activityLine));
  }

  if (payload.board.length > 0) {
    blocks.push(section('הודעות מלוח המודעות', lines.boardLine));
  }

  if (payload.homeworkDueTomorrow.length > 0) {
    // The one fact the model is not trusted to carry, and now the *only* thing
    // marking this date as derived: the explanatory caveat that used to follow
    // the section was removed as a daily wall of text. ADR-0027 is a promise
    // that a derived deadline is always labelled as derived, so the label and
    // the date are appended by the template rather than hoped for in the prose
    // -- and the date is safe to state once, because narrowing has already
    // reduced this section to the items whose estimate is tomorrow.
    const estimate = payload.homeworkDueTomorrow[0].estimatedDueDate;
    const label = estimate ? `צפי הגשה: ${formatSchoolDate(estimate)}` : 'צפי הגשה: מחר';
    blocks.push(section('צפי הגשה למחר', `${lines.dueTomorrowLine.trim()} (${label})`.trim()));
  }

  // Last, and a block of its own.
  //
  // Identifier-free on purpose. A Telegram chat is a shared, forwardable
  // artifact, and a studentGuid in someone else's hands outlives the message
  // it arrived in -- so the link goes to the home page and the parent picks
  // the child there, rather than carrying the child in the URL.
  //
  // At the end rather than under the header so the facts are what shows in the
  // chat list preview. `disable_web_page_preview` is already set on every
  // send, so this cannot grow a card.
  const link = options.publicBaseUrl ? `${options.publicBaseUrl}/home` : null;

  for (const fileName of options.unsentFileNames ?? []) {
    blocks.push(
      link
        ? `קובץ גדול מדי לשליחה: ${fileName} — ניתן לפתוח באתר: ${link}`
        : `קובץ גדול מדי לשליחה: ${fileName}`,
    );
  }

  if (link) blocks.push(link);

  return blocks.filter((block) => block.length > 0).join('\n\n');
}

/**
 * Plain text, no markup. Telegram's Markdown parse modes reject a whole message
 * when the text contains an unbalanced `*` or `_`, or (in MarkdownV2) any of
 * `.-!()`, which free-text teacher remarks and homework text routinely do. A
 * rejected message would fail, retry the next hour, and fail again. Hebrew
 * renders right-to-left in Telegram without any markup, so bold is not worth a
 * delivery failure.
 */
function section(title: string, prose: string): string {
  const trimmed = prose.trim();
  return trimmed.length > 0 ? `${title}\n${trimmed}` : '';
}

/**
 * The prose used when the model times out, refuses, or returns unusable output
 * -- and, per section, whenever it returns nothing for a section that has
 * items.
 *
 * It used to count ("one note was recorded today"), which worked only because
 * the bullets underneath said what the note was. With the bullets gone a
 * counting fallback would tell a parent that something happened and never what,
 * so these lines state the facts: subject, the teacher's own words, the text of
 * the assignment, the time, the deadline. Plainer than the model's prose, and
 * complete.
 */
export function deterministicLines(payload: DigestPayload): DigestLines {
  return {
    headline: 'עדכון יומי מבית הספר',
    behaviorLine: payload.behavior
      .filter((fact) => fact.classification !== 'positive')
      .map(behaviorSentence)
      .join(' '),
    positiveLine: payload.behavior
      .filter((fact) => fact.classification === 'positive')
      .map(behaviorSentence)
      .join(' '),
    homeworkLine:
      payload.homeworkNew.length === 0
        ? ''
        : `ניתנו המטלות הבאות: ${payload.homeworkNew.map(homeworkSentence).join('; ')}.`,
    dueTomorrowLine:
      payload.homeworkDueTomorrow.length === 0
        ? ''
        : `מה שצפוי להידרש מחר: ${payload.homeworkDueTomorrow.map(homeworkSentence).join('; ')}.`,
    releaseLine: payload.releases.map(releaseSentence).join(' '),
    boardLine: payload.board.map((fact) => boardSentence(fact)).join(' '),
    activityLine:
      payload.activities.length === 0
        ? ''
        : `ממתינים לתשובתך: ${payload.activities.map(activitySentence).join('; ')}.`,
  };
}

/**
 * Names the events the school does not count as excusing themselves.
 *
 * The template's, not the model's -- the same reasoning as the צפי label in
 * the due-tomorrow section. Whether an absence was excused changes what a
 * parent does next, so it must not depend on whether the prose happened to
 * mention it.
 *
 * `justifiable` is the school's own policy for the event's code, read from
 * BehaviorTypeReference by the sync tasks. It defaults to false when that
 * school's achvas have not synced yet, so the marker can over-report on a
 * fresh deployment -- which is the safe direction: it reports an absence as
 * needing attention rather than silently excusing it.
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
 * Not a count and not a summary: the report has no item bullets, so this line
 * is the only place the notice appears. The expiry date is not printed --
 * `expirationDate` is when the school takes the notice down, which is rarely
 * the date the notice is about, and printing it as a deadline would be a
 * promise nobody made.
 */
function boardSentence(fact: DigestBoardFact): string {
  const text = fact.text.trim().replace(/\s*\n\s*/g, ' ');
  return text.endsWith('.') ? text : `${text}.`;
}

function behaviorSentence(fact: DigestBehaviorFact): string {
  const head = [fact.achvaName, fact.subject].filter((part) => part && part.length > 0).join(' ב');
  const remark = fact.remark?.trim();
  return remark ? `נרשם ${head}: ${remark}.` : `נרשם ${head}.`;
}

function homeworkSentence(fact: DigestHomeworkFact): string {
  const text = fact.homeworkText.trim();
  const remark = fact.remark?.trim();
  return `${fact.subjectName} — ${remark ? `${text} (${remark})` : text}`;
}

/**
 * Day and time, and deliberately not the parent's `remark`.
 *
 * The remark was the one other place the child's name appeared in the message
 * ("אבקש לשחרר את יונתן"), and it is text the parent wrote themselves, so
 * dropping it with the bullets costs them nothing they did not already know.
 */
function releaseSentence(fact: DigestReleaseFact): string {
  return `שחרור מוקדם ב-${formatSchoolDate(fact.releaseDate)} בשעה ${formatTimeOfDay(fact.startHour)}.`;
}

function activitySentence(fact: DigestActivityFact): string {
  // The deadline clause is dropped when there is no deadline, rather than
  // printed as a formatted null.
  if (!fact.endAnswerDate) return fact.title;
  return `${fact.title} (יש להשיב עד ${formatSchoolDate(fact.endAnswerDate)})`;
}
