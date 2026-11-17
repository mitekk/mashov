import {
  DigestActivityFact,
  DigestBehaviorFact,
  DigestHomeworkFact,
  DigestLines,
  DigestPayload,
  DigestReleaseFact,
} from './digest.types';

/**
 * The fixed Hebrew report. The template owns every structural decision --
 * section headers, item bullets, the estimate label and its caveat -- so the
 * LLM writes sentences and never decides what is in the report. Hand it
 * `deterministicLines(payload)` instead and the same message renders with no
 * model involved at all.
 */

const CAVEAT =
  'המועד הוא צפי בלבד: מאשוב אינו מספק תאריך הגשה, והצפי מחושב לפי השיעור הבא או לפי מה שנכתב במטלה.';

/** Israeli date order, read from UTC fields -- every digest date is UTC midnight. */
export function formatSchoolDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

export function renderReport(payload: DigestPayload, lines: DigestLines): string {
  // Who and when first: this is what a parent scans for in a list of Telegram
  // chats, and it is the only place the child's name appears. Prose that
  // repeats the name reads like a form letter, so neither the deterministic
  // lines nor the system prompt reintroduce it.
  const blocks: string[] = [
    `${payload.childFirstName} · ${formatSchoolDate(payload.reportFor)}`,
    lines.headline.trim(),
  ];

  if (payload.behavior.length > 0) {
    blocks.push(section('התנהגות ונוכחות', lines.behaviorLine, payload.behavior.map(behaviorBullet)));
  }

  if (payload.homeworkNew.length > 0) {
    blocks.push(section('שיעורי בית חדשים', lines.homeworkLine, payload.homeworkNew.map(homeworkBullet)));
  }

  // Before homework: a child leaving at 11:30 changes the shape of the day in a
  // way that an exercise on page 42 does not.
  if (payload.releases.length > 0) {
    blocks.push(section('שחרור מוקדם', lines.releaseLine, payload.releases.map(releaseBullet)));
  }

  if (payload.activities.length > 0) {
    blocks.push(
      section('אישורים שממתינים לך', lines.activityLine, payload.activities.map(activityBullet)),
    );
  }

  if (payload.homeworkDueTomorrow.length > 0) {
    blocks.push(
      section(
        'צפי הגשה למחר',
        lines.dueTomorrowLine,
        payload.homeworkDueTomorrow.map(dueBullet),
      ),
    );
    blocks.push(CAVEAT);
  }

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
function section(title: string, prose: string, bullets: string[]): string {
  const body = [title];
  const trimmed = prose.trim();
  if (trimmed.length > 0) body.push(trimmed);
  body.push(...bullets.map((bullet) => `• ${bullet}`));
  return body.join('\n');
}

function behaviorBullet(fact: DigestBehaviorFact): string {
  const parts = [fact.achvaName, fact.subject].filter((part) => part && part.length > 0);
  const head = parts.join(' — ');
  const remark = fact.remark?.trim();
  return remark ? `${head}: ${remark}` : head;
}

function homeworkBullet(fact: DigestHomeworkFact): string {
  const text = fact.homeworkText.trim();
  const remark = fact.remark?.trim();
  const body = remark ? `${text} (${remark})` : text;
  return `${fact.subjectName}: ${body}`;
}

/**
 * The parent filed this request, so their own `remark` is shown back to them --
 * it is the reason they will recognise the row by. It is the one free-text
 * field the report renders but the prompt never carries: it routinely names
 * the child, and no part of the child's name goes to the model.
 */
function releaseBullet(fact: DigestReleaseFact): string {
  const head = `${formatSchoolDate(fact.releaseDate)} בשעה ${formatTimeOfDay(fact.startHour)}`;
  const remark = fact.remark?.trim();
  return remark ? `${head} — ${remark}` : head;
}

function activityBullet(fact: DigestActivityFact): string {
  return `${fact.title} — יש להשיב עד ${formatSchoolDate(fact.endAnswerDate)}`;
}

/** "11:30:00" is a column value; a parent reads "11:30". */
function formatTimeOfDay(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * Deliberately says "צפי הגשה" (estimated) and never "תאריך הגשה" (due date).
 * Mashov exposes only lessonDate, when the work was given; there is no due-date
 * field to promise. See ADR-0026.
 */
function dueBullet(fact: DigestHomeworkFact): string {
  const base = homeworkBullet(fact);
  return fact.estimatedDueDate
    ? `${base} — צפי הגשה: ${formatSchoolDate(fact.estimatedDueDate)}`
    : `${base} — צפי הגשה: מחר`;
}

/**
 * The prose used when the LLM times out, refuses, or returns malformed output.
 * It counts what happened instead of describing it, which is all a template
 * needs to render a complete, honest message. A parent getting a plainer
 * message beats a parent getting nothing.
 */
export function deterministicLines(payload: DigestPayload): DigestLines {
  const behaviorCount = payload.behavior.length;
  const newCount = payload.homeworkNew.length;
  const dueCount = payload.homeworkDueTomorrow.length;
  const releaseCount = payload.releases.length;
  const activityCount = payload.activities.length;

  return {
    headline: 'עדכון יומי מבית הספר',
    behaviorLine:
      behaviorCount === 0
        ? ''
        : behaviorCount === 1
          ? 'נרשמה הערת התנהגות אחת היום.'
          : `נרשמו ${behaviorCount} הערות התנהגות היום.`,
    homeworkLine:
      newCount === 0
        ? ''
        : `${newCount === 1 ? 'ניתנה מטלה אחת' : `ניתנו ${newCount} מטלות`} היום.`,
    dueTomorrowLine:
      dueCount === 0
        ? ''
        : `${dueCount === 1 ? 'מטלה אחת' : `${dueCount} מטלות`} בצפי הגשה למחר.`,
    releaseLine:
      releaseCount === 0
        ? ''
        : releaseCount === 1
          ? 'יש שחרור מוקדם אחד בתוקף.'
          : `יש ${releaseCount} שחרורים מוקדמים בתוקף.`,
    activityLine:
      activityCount === 0
        ? ''
        : activityCount === 1
          ? 'יש אישור אחד שממתין לתשובה שלך.'
          : `יש ${activityCount} אישורים שממתינים לתשובה שלך.`,
  };
}
