// ─── Common ────────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

/**
 * A downloadable file attached to a mail message, homework item or behavior
 * event. All three upstream payloads carry exactly these two fields — no MIME
 * type and no size — which is why the viewer reads the type from the download
 * response's `Content-Type` header instead.
 */
export interface Attachment {
  fileId: string;
  fileName: string;
}

// ─── Freshness ─────────────────────────────────────────────────────────────

export type FreshnessState = 'fresh' | 'syncing' | 'stale' | 'degraded';

export interface FreshnessStatus {
  state: FreshnessState;
  lastSyncAt: string | null;
  staleSources: string[];
}

// ─── Dashboard ─────────────────────────────────────────────────────────────

export interface DashboardSummary {
  newConversations: number;
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  childrenCount: number;
}

export type FeedSourceType = 'homework' | 'behavior' | 'mail' | 'positive';
export type FeedPriority = 'high' | 'medium' | 'low';

export interface FeedItem {
  id: string;
  sourceType: FeedSourceType;
  sourceId: string;
  studentGuid: string | null;
  studentName: string | null;
  /** `null` for mail (household-wide) and for an unstamped child. */
  schoolId: string | null;
  schoolShortLabel: string | null;
  title: string;
  summary: string;
  category: string;
  priority: FeedPriority;
  isPositive: boolean;
  isNew: boolean;
  isArchived: boolean;
  hasAttachments: boolean;
  eventAt: string;
  syncedAt: string;
  linkPath: string;
}

export interface DashboardChildCard {
  studentGuid: string;
  privateName: string;
  familyName: string;
  fullName: string;
  classCode: string;
  classNum: number;
  /** Unread this school year, not a rolling window (ADR-0034). */
  recentHomeworkCount: number;
  /** Unread `attention` events this school year. */
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  /** Attendance and anything unmapped: shown, but not as negative. */
  neutralBehaviorCount: number;
  latestUpdateAt: string | null;
  oneLineStatus: string;
  /** `null` for a child with no ownership stamp: the UI shows no badge. */
  schoolId: string | null;
  schoolShortLabel: string | null;
}

export interface DashboardResponse {
  freshness: FreshnessStatus;
  summary: DashboardSummary;
  feed: FeedItem[];
  children: DashboardChildCard[];
}

// ─── Feed ──────────────────────────────────────────────────────────────────

export type FeedResponse = PaginatedResponse<FeedItem>;

// ─── Children ──────────────────────────────────────────────────────────────

export interface ChildListItem {
  studentGuid: string;
  privateName: string;
  familyName: string;
  fullName: string;
  classCode: string;
  classNum: number;
  gender: string;
  isActive: boolean;
  /** Unread this school year, not a rolling window (ADR-0034). */
  recentHomeworkCount: number;
  /** Unread `attention` events this school year. */
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  /** Attendance and anything unmapped: shown, but not as negative. */
  neutralBehaviorCount: number;
  subjectCount: number;
  latestUpdateAt: string | null;
  /** `null` for a child with no ownership stamp: the UI shows no badge. */
  schoolId: string | null;
  schoolName: string | null;
  schoolShortLabel: string | null;
  semel: number | null;
}

export interface ChildrenResponse {
  data: ChildListItem[];
}

export interface ChildStudent {
  studentGuid: string;
  privateName: string;
  familyName: string;
  fullName: string;
  classCode: string;
  classNum: number;
  gender: string;
  isActive: boolean;
}

export interface ChildSummary {
  /** Unread this school year, not a rolling window (ADR-0034). */
  recentHomeworkCount: number;
  /** Unread `attention` events this school year. */
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  /** Attendance and anything unmapped: shown, but not as negative. */
  neutralBehaviorCount: number;
  subjectCount: number;
  totalWeeklyHours: number;
}

export interface ChildWorkspaceResponse {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
}

export interface StudentRelease {
  id: number;
  studentGuid: string;
  contactGuid: string;
  releaseDate: string;
  startHour: string;
  remark: string;
  status: number;
  isDeleted: boolean;
  requestEditTime: string;
}

export interface StudentReleasesResponse {
  data: StudentRelease[];
}

export interface UpdateStudentReleaseBody extends StudentRelease {
  releaseDateMoment: string;
  isExpired: boolean;
  isDirty_menu: boolean;
}

export interface CreateStudentReleaseBody {
  releaseDate: string;
  remark: string;
  studentGuid: string;
  startHour: string;
}

export interface SchoolActivity {
  id: number;
  createTime: string;
  activityStartDate: string;
  activityEndDate: string;
  activityType: number;
  creatorGuid: string;
  title: string;
  description: string;
  endAnswerDate: string;
  isAnswered: boolean;
}

// ─── Homework ──────────────────────────────────────────────────────────────

export type HomeworkFile = Attachment;

export interface HomeworkItem {
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  lessonDate: string;
  lesson: number;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  files: HomeworkFile[];
  isNew: boolean;
  isArchived: boolean;
  /**
   * The item belongs to a school year the student has already left, which the
   * API derives rather than stores. Such an item is always archived and can
   * never be restored, so the UI shows a `שנה קודמת` badge where the archive
   * toggle would be (ADR-0036).
   */
  isPastYear: boolean;
  updatedAt: string;
}

export type HomeworkResponse = PaginatedResponse<HomeworkItem>;
export type HomeworkDetailResponse = HomeworkItem;

// ─── Behavior ──────────────────────────────────────────────────────────────

export type BehaviorBucket = 'attention' | 'positive' | 'neutral';

export type BehaviorFile = Attachment;

export interface BehaviorItem {
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  eventCode: number;
  achvaCode: number;
  achvaName: string;
  bucket: BehaviorBucket;
  priority: FeedPriority;
  justifiable: boolean;
  lessonDate: string;
  lesson: number | null;
  subject: string;
  reporter: string;
  remark: string | null;
  justification: string | null;
  files: BehaviorFile[];
  eventAt: string;
  isNew: boolean;
  isArchived: boolean;
  /** See `HomeworkItem.isPastYear`. */
  isPastYear: boolean;
  updatedAt: string;
}

export type BehaviorResponse = PaginatedResponse<BehaviorItem>;
export type BehaviorDetailResponse = BehaviorItem;

// ─── Subjects ──────────────────────────────────────────────────────────────

export interface TeacherInfo {
  teacherGuid: string;
  teacherName: string;
}

export interface SubjectEnrollment {
  id: string;
  studentGuid: string;
  groupId: number;
  groupName: string;
  subjectName: string;
  teachers: TeacherInfo[];
  inactiveTeachers: TeacherInfo[];
  weeklyHours: number;
  lessonsCount: number;
  updatedAt: string;
}

export interface SubjectsResponse {
  data: SubjectEnrollment[];
}

// ─── Notices ───────────────────────────────────────────────────────────────

export interface NoticeItem {
  id: string;
  studentGuid: string;
  eventId: number;
  eventText: string;
  expirationDate: string;
  inSite: boolean;
  updatedAt: string;
}

export interface NoticesResponse {
  data: NoticeItem[];
}

// ─── Mail ──────────────────────────────────────────────────────────────────

export interface RecentConversation {
  conversationId: string;
  subject: string;
  senderNamePreview: string;
  sendTime: string;
  isNew: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
}

export interface MailSummary {
  newConversations: number;
  recentConversations: RecentConversation[];
  lastSyncAt: string | null;
}

export interface ConversationListItem {
  conversationId: string;
  subject: string;
  senderNamePreview: string;
  sendTime: string;
  isNew: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  lastFetchedAt: string;
  /** `null` on an unstamped conversation: the UI shows no badge. */
  schoolId: string | null;
  schoolShortLabel: string | null;
}

export type ConversationsResponse = PaginatedResponse<ConversationListItem>;

export interface MessageRecipient {
  displayOrder: number;
  displayName: string;
  valueType: string;
  targetType: string;
  isGroup: boolean;
}

export type ConversationAttachment = Attachment;

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  bodyHtmlSanitized: string;
  bodyTextPreview: string;
  sendTime: string;
  isNew: boolean;
  recipients: MessageRecipient[];
  files: ConversationAttachment[];
  hasAttachments: boolean;
  preventReply: boolean;
  sentViaEmail: boolean;
  sentViaSms: boolean;
}

export interface ConversationDetail {
  conversationId: string;
  subject: string;
  sendTime: string;
  isNew: boolean;
  hasDrafts: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  messages: ConversationMessage[];
  lastFetchedAt: string;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export type SourceStatus = 'fresh' | 'stale' | 'failed' | 'never_synced';

export interface SourceHealth {
  source: string;
  status: SourceStatus;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorMessage: string | null;
  fetchedCount: number | null;
  staleThresholdMinutes: number;
}

/**
 * The age of the *content*, not of the last sync. `stale_year` is the state
 * that catches a dead school year — every source can read `fresh` while the
 * newest homework in the database is from a school year that has ended.
 */
export type ContentFreshnessStatus = 'current' | 'stale_year' | 'no_content';

export interface ContentFreshness {
  expectedSchoolYear: number;
  observedSchoolYear: number;
  newestContentAt: string | null;
  contentAgeDays: number | null;
  status: ContentFreshnessStatus;
}

export interface SourceHealthResponse {
  sources: SourceHealth[];
  overallState: FreshnessState;
  lastFullSyncAt: string | null;
  contentFreshness: ContentFreshness | null;
}

/** One child of one school, as the parent-details card lists them. */
export interface ProfileChild {
  studentGuid: string;
  fullName: string;
  classCode: string;
  classNum: number;
}

export interface ParentProfile {
  /// Which linked school these details were read from. `upstreamUserId` is a
  /// per-school id, so a two-school household has one entry per school and
  /// the caption must say which one.
  householdConnectionId: string;
  upstreamUserId: string;
  displayName: string;
  email: string;
  cellphone: string;
  schoolName: string;
  schoolYear: number;
  schoolCode: number;
  detailsState: number;
  /**
   * The children THIS school lists, from the visibility edge rather than from
   * the name string.
   *
   * `displayName` used to carry one of them in brackets -- the creating
   * credential's -- which is how both of a two-school parent's cards came to
   * name the same child. `[]` while a school's first roster sync is pending.
   */
  children: ProfileChild[];
  updatedAt: string;
}

// ─── IsNew / Archive mutations ─────────────────────────────────────────────

export interface MarkIsNewRequest { isNew: boolean }
export interface MarkArchivedRequest { isArchived: boolean }

// ─── Bulk Child Actions ────────────────────────────────────────────────────

export interface BulkUpdateResponse {
  updated: number;
}

export interface HomeworkBulkIsNewRequest {
  homeworkIds: string[];
  isNew: boolean;
}

export interface HomeworkBulkArchiveRequest {
  homeworkIds: string[];
  isArchived: boolean;
}

export interface BehaviorBulkIsNewRequest {
  behaviorIds: string[];
  isNew: boolean;
}

export interface BehaviorBulkArchiveRequest {
  behaviorIds: string[];
  isArchived: boolean;
}

// ─── Sync ──────────────────────────────────────────────────────────────────

export type SyncTaskStatus = 'success' | 'failed';
/**
 * `failed` is a school whose refresh threw: `POST /sync/refresh` runs one per
 * connection and aggregates worst-wins, so a school that never returned has no
 * `partial` to report.
 */
export type SyncRefreshStatus = 'success' | 'partial' | 'failed';

export interface SyncTaskSummary {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
}

export interface SyncTaskResult {
  task: string;
  status: SyncTaskStatus;
  summary: SyncTaskSummary;
  errorMessages: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/** One school's own outcome, so a two-school household is not one number. */
export interface SyncRefreshSchool {
  schoolId: string;
  semel: number;
  schoolName: string | null;
  status: SyncRefreshStatus;
}

export interface SyncRefreshResponse {
  /**
   * Worst-wins across every school in the household, and `tasks` is the
   * concatenation of theirs. Both described the first connection alone until
   * the envelope was aggregated.
   */
  status: SyncRefreshStatus;
  /** Earliest start and latest end across the schools: the span the parent waited. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /**
   * One entry per task **per school**, concatenated — so `task` is not unique.
   * A two-school household carries two `homework` entries, and both
   * `tasks.find((t) => t.task === …)` and `key={task.task}` would silently keep
   * one school and drop the other. Group by school instead.
   */
  tasks: SyncTaskResult[];
  /** One entry per refreshed connection. Additive; no caller reads it yet. */
  schools: SyncRefreshSchool[];
}

// ─── Timetable ─────────────────────────────────────────────────────────────

export interface TimetableEntry {
  id: string;
  studentGuid: string;
  groupId: number;
  day: number;
  lesson: number;
  roomNum: string;
  weeks: number;
  groupName: string;
  subjectName: string;
  teachers: TeacherInfo[];
  updatedAt: string;
}

/** One lesson period's clock window, both ends as "HH:MM". */
export interface BellPeriod {
  lesson: number;
  startTime: string;
  endTime: string;
}

/**
 * A gap between two periods. Derived server-side from the bell schedule, not
 * fetched: the upstream serves period rows only (ADR-0037).
 */
export interface BellBreak {
  afterLesson: number;
  startTime: string;
  endTime: string;
  minutes: number;
  kind: 'recess' | 'lunch';
}

/**
 * The school day's clock, and where it came from.
 *
 * `source: 'default'` means these are the bundled approximate times, not the
 * school's own — anything that renders them has to say so.
 */
export interface TimetableSchedule {
  source: 'school' | 'default';
  periods: BellPeriod[];
  breaks: BellBreak[];
}

/**
 * `schedule` is optional on purpose: a backend older than the bell schedule
 * answers without it, and the grid still has to render.
 */
export type TimetableResponse = { data: TimetableEntry[]; schedule?: TimetableSchedule };

// ─── Lesson Plans ───────────────────────────────────────────────────────────

export interface LessonPlan {
  groupid: number;
  lessondate: string;
  lesson: number;
  plan: string;
  lessonLink?: string;
}

export type LessonPlansResponse = { data: LessonPlan[] };

// ─── Lesson History ─────────────────────────────────────────────────────────

export interface LessonHistoryLog {
  lessonID: number;
  groupId: number;
  lessonDate: string;
  lesson: number;
  tookPlace: boolean;
  remark: string;
  homeWork?: string;
  lessontype: number;
  reporterid: number;
  reporterGuid: string;
}

export interface LessonHistoryEntry {
  groupName: string;
  subjectName: string;
  lessonLog: LessonHistoryLog;
}

export type LessonHistoryResponse = { data: LessonHistoryEntry[] };

// ─── Bulk Mail Actions ─────────────────────────────────────────────────────

export interface MailBulkActionRequest {
  conversationIds: string[];
}

export interface MailBulkActionResponse {
  updated: number;
}

// ─── Auth / User ───────────────────────────────────────────────────────────

/** The slice of a school link every page's badge needs. */
export interface MeSchool {
  id: string;
  semel: number;
  schoolName: string;
  /** Short enough for a chip on a 360px row; resolved server-side. */
  shortLabel: string;
  schoolYear: number;
}

export interface AppUser {
  mashovUserId: string;
  username: string;
  /** The parent's own name; the credential's `[child class]` tag is stripped. */
  displayName: string;
  /**
   * How many children the household has, over the same predicate
   * `GET /children` uses -- so the header and that page cannot disagree.
   */
  childrenCount: number;
  /**
   * Every connected school, newest sign-in first; `[]` when none.
   *
   * Every new school-aware surface gates on `schools.length >= 2`, so with one
   * school the DOM is byte-identical to before this field existed.
   */
  schools: MeSchool[];
}

/** One connected Mashov account, as the management screen needs it. */
export interface SchoolLink {
  id: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
  schoolYear: number;
  /** Shown so a parent with two accounts can tell them apart. Never a password. */
  username: string;
  childrenCount: number;
  isPrimary: boolean;
  lastLoginAt: string | null;
  /** `null` means the first sync has not finished yet. */
  lastSyncAt: string | null;
  active: boolean;
}

export type SchoolLinksResponse = PaginatedResponse<SchoolLink>;

export interface School {
  semel: number;
  name: string;
  years: number[];
}

export interface LoginRequest {
  semel: number;
  username: string;
  password: string;
}

export interface LoginResponse {
  ok: boolean;
  isFirstLogin: boolean;
}

// ─── Sync Status ───────────────────────────────────────────────────────────

/**
 * `idle` — no refresh in flight. `stale` — a running refresh stopped reporting,
 * so whoever owned it is gone. `unknown` — the backend could not read the
 * progress store; the client keeps polling rather than treating it as failure.
 */
export type SyncStatusPhase =
  | 'idle'
  | 'running'
  | 'stale'
  | 'success'
  | 'partial'
  | 'failed'
  | 'unknown';

export interface SyncTaskProgress {
  task: string;
  status: 'running' | 'success' | 'failed';
}

export interface SyncStatus {
  done: boolean;
  /** Legacy alias for `tasksSettled`, kept for older payloads. */
  sourcesCompleted: number;
  /** Legacy alias for `tasksTotal`, kept for older payloads. */
  sourcesTotal: number;
  // Everything below is optional on purpose: a payload from before the refresh
  // envelope landed is still a valid SyncStatus.
  phase?: SyncStatusPhase;
  refreshId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  tasksTotal?: number;
  tasksSettled?: number;
  tasksFailed?: number;
  currentTask?: string | null;
  tasks?: SyncTaskProgress[];
}

// --- Telegram updates -------------------------------------------------------
//
// A parent connects their own Telegram in `/more` rather than an operator
// inserting a chat id by hand. See ADR-0033.

/** One child's subscription to a delivery channel. */
export interface DigestRecipient {
  id: string;
  userId: string;
  studentGuid: string;
  /** 'telegram' today; the backend's DigestSender interface allows more. */
  channel: string;
  /** Telegram chat id. */
  address: string;
  displayName: string | null;
  enabled: boolean;
  activeFrom: string;
  createdAt: string;
  updatedAt: string;
}

export interface DigestRecipientsResponse {
  data: DigestRecipient[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface DigestRecipientResponse {
  data: DigestRecipient;
}

/** A freshly minted one-time link, and where to send the parent with it. */
export interface TelegramLink {
  code: string;
  deepLink: string;
  botUsername: string;
  expiresAt: string;
}

export interface TelegramLinkResponse {
  data: TelegramLink;
}

export type TelegramLinkStatus = 'pending' | 'linked' | 'expired';

export interface TelegramLinkState {
  status: TelegramLinkStatus;
  linkedAt: string | null;
  recipientCount: number;
  /** The confirmation message the backend sends the instant the chat is bound. */
  confirmationSent: boolean;
  /**
   * Bound, but the confirmation has neither landed nor failed yet. The backend
   * marks the code consumed before it has tried to send, so this is the state
   * to wait in rather than resolve pessimistically.
   */
  confirmationPending: boolean;
  confirmationError: string | null;
  /**
   * The children the server actually subscribed, which is not always what the
   * parent ticked: one whose roster links moved between minting and START is
   * skipped. The last step names these.
   */
  subscribedGuids: string[];
  /**
   * Whether this server will actually send briefings from here on --
   * DIGEST_ENABLED and not DIGEST_DRY_RUN. The last step says so plainly rather
   * than promising messages that will never arrive.
   */
  deliveryEnabled: boolean;
}

export interface TelegramLinkStateResponse {
  data: TelegramLinkState;
}
