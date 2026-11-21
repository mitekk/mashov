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
export type DigestItemType =
  | 'behavior'
  | 'homework_new'
  | 'homework_due'
  | 'release'
  | 'activity';

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
   * due-date field at all (see ADR-0027), so this is an estimate and the report
   * must label it as one.
   */
  estimatedDueDate?: Date | null;
  /** Whether the Hebrew text looked like it named a deadline of its own. */
  hasTextHint?: boolean;
  /**
   * The item's own date -- `lessonDate` for homework, the later of `eventAt`
   * and `lessonDate` for behaviour. Carried out of the checker because it is
   * what the re-query window is measured from: a deferral is only reachable
   * again while this date is still inside the lookback (see
   * DigestService.settleUnsent).
   */
  itemDate?: Date;
}

/**
 * An early release scheduled for today or tomorrow.
 *
 * The parent filed this themselves, so it is a reminder rather than news --
 * which is why only the imminent ones are reported, and why `remark` (their
 * own words) is rendered back to them but never put in the prompt: it
 * routinely names the child, and no part of the child's name goes to the
 * model.
 */
export interface DigestReleaseFact {
  id: string;
  releaseDate: Date;
  /** "11:30:00" as Mashov sends it; the template trims it to "11:30". */
  startHour: string;
  remark: string | null;
}

/**
 * A consent form the parent has not answered yet, with its deadline near.
 *
 * Household-scoped upstream, so it is reported under one child only -- see
 * `DigestCheckerService.activitiesAwaitingAnswer`. The consent letter itself
 * is not here: it names staff and other children, and the title plus the
 * deadline is the whole actionable content.
 */
export interface DigestActivityFact {
  id: string;
  title: string;
  activityStartDate: Date;
  /** Null when the school published no response deadline. */
  endAnswerDate: Date | null;
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
export type DigestGender = 'male' | 'female';

export interface DigestPayload {
  /**
   * First name only, and the **template's** alone: it heads the rendered
   * message and is never put in the prompt, so no part of the child's name
   * leaves the host. See `buildPrompt` and ADR-0026.
   */
  childFirstName: string;
  /**
   * What the prose needs instead of the name. Hebrew verbs are gendered, and
   * many Israeli first names are not (נועם, שחר, רותם), so the name was never
   * a dependable signal. `null` when the roster does not say.
   */
  childGender: DigestGender | null;
  /** The school day this report covers, UTC midnight. */
  reportFor: Date;
  behavior: DigestBehaviorFact[];
  homeworkNew: DigestHomeworkFact[];
  homeworkDueTomorrow: DigestHomeworkFact[];
  releases: DigestReleaseFact[];
  activities: DigestActivityFact[];
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
  releaseLine: string;
  activityLine: string;
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
