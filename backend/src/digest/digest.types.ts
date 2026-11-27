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
  | 'activity'
  | 'message_board';

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

/**
 * A message-board notice as the parent will see it.
 *
 * Per student, but its content is usually school-wide, so siblings each get
 * their own copy -- the board is fetched per studentGuid and dedup is per
 * (child, parent), so there is nothing to collapse them against.
 */
export interface DigestBoardFact {
  /** The upstream `eventId`, as a string, because that is what the ledger holds. */
  id: string;
  /** Already stripped to plain text; the sync task stores it as HTML. */
  text: string;
  expirationDate: Date;
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

/**
 * One graded assessment as the parent will see it.
 *
 * `teacherName` is on the row and is deliberately NOT here. It is the only
 * field of a grade that names a person, the message has no use for it -- a
 * parent knows who teaches the subject -- and keeping it off this shape is
 * what keeps it out of the prompt by construction rather than by discipline.
 *
 * Two dates on the row, and this is the later-surprising one: `eventDate` is
 * when the test was sat, `enteredAt` when the teacher keyed the mark in, and
 * they can be weeks apart. The sentence prints `eventDate`, because a parent
 * reading "92" today needs to know which test it was; the checker will care
 * about `enteredAt`, since that is when the grade became news.
 */
export interface DigestGradeFact {
  /** GradeItem.id. */
  id: string;
  subjectName: string;
  /** The assessment's own name, e.g. "מבחן בשברים". May be blank upstream. */
  gradingEvent: string;
  /** Its category, e.g. "מבחן" -- the fallback when the event has no name. */
  gradeType: string;
  grade: number;
  /** When the assessment was sat, NOT when the mark was entered. */
  eventDate: Date;
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
  board: DigestBoardFact[];
  /**
   * New grades. Rendered by the template today; nothing fills this list yet --
   * the checker and the collector do not look at `GradeItem` at all, so it is
   * always empty until that is wired.
   */
  grades: DigestGradeFact[];
}

/**
 * The sections a report can have, in the order it renders them.
 *
 * One id per rendered section rather than per payload list, because the
 * behaviour list feeds two of them: a sentence that blends praise into an
 * absence lands under a heading that fits neither.
 */
export const DIGEST_SECTION_IDS = [
  'behavior',
  'positive',
  'grades',
  'homeworkNew',
  'release',
  'activity',
  'board',
  'dueTomorrow',
] as const;

export type DigestSectionId = (typeof DIGEST_SECTION_IDS)[number];

/**
 * The prose the summarizer produces.
 *
 * It used to be one paragraph per section, and that is what read as
 * unpolished. The prompt asked for warm conversational prose AND a complete
 * record of every subject, every exact assignment text, every time and date,
 * in one sentence -- two incompatible jobs, which the model did by cramming.
 *
 * So the grain changed: the model writes ONE SHORT SENTENCE PER ITEM, naming
 * that item's own details and nothing else, and the template lays the lines
 * out as bullets under a heading. The section intro is optional and only earns
 * its place when it says something the item lines do not. See ADR-0047.
 *
 * This is not a return to the item bullets ADR-0026 removed. Those were the
 * raw record stapled underneath the prose; these ARE the prose, one line per
 * thing that happened.
 *
 * The template still owns every structural decision -- which sections exist,
 * the emoji markers, the `צפי הגשה` label, the unexcused marker, the whole
 * consent section -- so the model never decides what is in the report.
 */
export interface DigestProse {
  /** One line summarising the day. No date, no name. */
  headline: string;
  /** Optional, and often absent: `''` means "the item lines said it already". */
  intros: Partial<Record<DigestSectionId, string>>;
  /**
   * One line per item, keyed by `digestItemRef(section, id)`.
   *
   * Keyed per section rather than by bare item id because one homework row is
   * reported twice on the day it is both newly assigned and estimated-due, and
   * a bare id would make the two sections share one sentence -- a
   * "due tomorrow" line showing up under "new homework".
   */
  itemLines: Record<string, string>;
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
  prose: DigestProse;
  /**
   * Derived from the model's `items` rather than asked for separately.
   *
   * It used to be its own top-level array keyed by the same refs as the lines,
   * which meant the model answered the same question in two places and could
   * answer it differently in each.
   */
  deadlineResolutions: DigestDeadlineResolution[];
  /**
   * Every explicit date the model read out of an assignment text, keyed by the
   * NAMESPACED ref (`digestItemRef(section, id)`) and valued as `YYYY-MM-DD`.
   *
   * Deliberately separate from `deadlineResolutions`, which strips the
   * namespace to the bare homework id for the deferral ledger and therefore
   * has to exclude `homeworkNew` entirely -- two refs for one row would
   * collide there. The template's submission summary needs the opposite: every
   * homework item, each told apart from the other, so the TL;DR can say when a
   * newly assigned thing is due. Empty whenever the model was not used.
   */
  explicitDueDates: Record<string, string>;
  /** False when the fallback renderer produced the prose. */
  usedLlm: boolean;
}
