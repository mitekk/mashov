import { DigestBehaviorFact, DigestHomeworkFact, DigestLines, DigestPayload } from './digest.types';

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
  const blocks: string[] = [
    lines.headline.trim(),
    `${payload.childFirstName} · ${formatSchoolDate(payload.reportFor)}`,
  ];

  if (payload.behavior.length > 0) {
    blocks.push(section('התנהגות ונוכחות', lines.behaviorLine, payload.behavior.map(behaviorBullet)));
  }

  if (payload.homeworkNew.length > 0) {
    blocks.push(section('שיעורי בית חדשים', lines.homeworkLine, payload.homeworkNew.map(homeworkBullet)));
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

function section(title: string, prose: string, bullets: string[]): string {
  const body = [`*${title}*`];
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

  return {
    headline: `עדכון יומי · ${payload.childFirstName}`,
    behaviorLine:
      behaviorCount === 0
        ? ''
        : `נרשמו ${behaviorCount} ${behaviorCount === 1 ? 'הערת התנהגות' : 'הערות התנהגות'} היום.`,
    homeworkLine:
      newCount === 0
        ? ''
        : `${newCount === 1 ? 'ניתנה מטלה אחת' : `ניתנו ${newCount} מטלות`} היום.`,
    dueTomorrowLine:
      dueCount === 0
        ? ''
        : `${dueCount === 1 ? 'מטלה אחת' : `${dueCount} מטלות`} בצפי הגשה למחר.`,
  };
}
