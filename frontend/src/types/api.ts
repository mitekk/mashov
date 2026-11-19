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
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  latestUpdateAt: string | null;
  oneLineStatus: string;
}

export interface SchoolInfo {
  schoolName: string;
  schoolYear: number;
}

export interface DashboardResponse {
  freshness: FreshnessStatus;
  summary: DashboardSummary;
  feed: FeedItem[];
  children: DashboardChildCard[];
  school: SchoolInfo;
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
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  subjectCount: number;
  latestUpdateAt: string | null;
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
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  subjectCount: number;
  totalWeeklyHours: number;
  attentionBehaviorCount: number;
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

export interface ParentProfile {
  upstreamUserId: string;
  displayName: string;
  email: string;
  cellphone: string;
  schoolName: string;
  schoolYear: number;
  schoolCode: number;
  detailsState: number;
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
export type SyncRefreshStatus = 'success' | 'partial';

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

export interface SyncRefreshResponse {
  status: SyncRefreshStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  tasks: SyncTaskResult[];
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

export type TimetableResponse = { data: TimetableEntry[] };

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

export interface ConnectedSchool {
  schoolName: string;
  schoolYear: number;
}

export interface AppUser {
  mashovUserId: string;
  username: string;
  displayName: string;
  connectedSchool: ConnectedSchool | null;
}

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
