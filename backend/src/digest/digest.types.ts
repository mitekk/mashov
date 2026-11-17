/**
 * Shared shapes for the per-child daily digest.
 *
 * Every date in here is UTC midnight of a Jerusalem calendar day. Mashov sends
 * naive local timestamps ("2025-09-05T00:00:00") which a UTC container stores as
 * ...T00:00:00Z, so that is the only representation the digest ever uses. See
 * `jerusalemDayBounds`.
 */

/**
 * The *reason* an item was reported, not its table. Distinct types let one
 * homework row be reported once as newly assigned and later as estimated-due.
 */
export type DigestItemType = 'behavior' | 'homework_new' | 'homework_due';

/** An item the checker believes has not yet been reported to this child's parents. */
export interface DigestCandidate {
  itemType: DigestItemType;
  /** HomeworkItem.id or BehaviorItem.id. */
  itemId: string;
  /** sha256 over exactly the fields the parent will see. */
  contentHash: string;
  /**
   * The timetable-derived estimate of when this homework is next needed, when
   * the item is a `homework_due` candidate. Never a promise: Mashov exposes no
   * due-date field at all (see ADR-0026), so this is an estimate and the report
   * must label it as one.
   */
  estimatedDueDate?: Date | null;
  /** Whether the Hebrew text looked like it named a deadline of its own. */
  hasTextHint?: boolean;
}

/** A behavior event as the parent will see it. */
export interface DigestBehaviorFact {
  id: string;
  achvaName: string;
  classification: string;
  justifiable: boolean;
  subject: string;
  remark: string | null;
  lessonDate: Date;
  eventAt: Date;
}

/** A homework item as the parent will see it. */
export interface DigestHomeworkFact {
  id: string;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  lessonDate: Date;
  groupId: number;
  /** Set only for due-tomorrow candidates. */
  estimatedDueDate?: Date | null;
}

/** Everything the summarizer and the template are allowed to see for one child. */
export interface DigestPayload {
  /**
   * First name only. Family names never reach the prompt -- see
   * `buildPrompt` and ADR-0025.
   */
  childFirstName: string;
  /** The school day this report covers, UTC midnight. */
  reportFor: Date;
  behavior: DigestBehaviorFact[];
  homeworkNew: DigestHomeworkFact[];
  homeworkDueTomorrow: DigestHomeworkFact[];
}

/**
 * The prose the summarizer produces. The template owns every structural
 * decision -- section headers, item bullets, the estimate label -- so the LLM
 * writes sentences and never decides what is in the report.
 */
export interface DigestLines {
  headline: string;
  behaviorLine: string;
  homeworkLine: string;
  dueTomorrowLine: string;
}

/** Per-candidate deadline the LLM claims to have found written in the text. */
export interface DigestDeadlineResolution {
  /** Matches DigestHomeworkFact.id. */
  ref: string;
  /** ISO date (YYYY-MM-DD), or null when the text named none. */
  explicitDueDate: string | null;
}

/** What the summarizer returns: prose plus the deadlines it read out of the text. */
export interface DigestSummary {
  lines: DigestLines;
  deadlineResolutions: DigestDeadlineResolution[];
  /** False when the fallback renderer produced the prose. */
  usedLlm: boolean;
}
