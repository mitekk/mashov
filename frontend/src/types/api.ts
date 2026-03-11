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

// ─── Freshness ─────────────────────────────────────────────────────────────

export type FreshnessState = 'fresh' | 'syncing' | 'stale' | 'degraded';

export interface FreshnessStatus {
  state: FreshnessState;
  lastSyncAt: string | null;
  staleSources: string[];
}

// ─── Dashboard ─────────────────────────────────────────────────────────────

export interface DashboardSummary {
  unreadConversations: number;
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  childrenCount: number;
}

export type NeedsAttentionType =
  | 'unread_conversation'
  | 'negative_behavior'
  | 'unhandled_homework'
  | 'sync_degraded';

export interface NeedsAttentionItem {
  id: string;
  type: NeedsAttentionType;
  title: string;
  summary: string;
  studentGuid: string | null;
  studentName: string | null;
  timestamp: string;
  linkPath: string;
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
  isUnread: boolean;
  isHandled: boolean;
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
  needsAttention: NeedsAttentionItem[];
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
  subjectCount: number;
  totalWeeklyHours: number;
  attentionBehaviorCount: number;
}

export interface ChildWorkspaceResponse {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
}

// ─── Homework ──────────────────────────────────────────────────────────────

export interface HomeworkFile {
  fileId: string;
  fileName: string;
}

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
  isHandled: boolean;
  updatedAt: string;
}

export type HomeworkResponse = PaginatedResponse<HomeworkItem>;

// ─── Behavior ──────────────────────────────────────────────────────────────

export type BehaviorBucket = 'attention' | 'positive' | 'neutral';

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
  eventAt: string;
  isHandled: boolean;
  updatedAt: string;
}

export type BehaviorResponse = PaginatedResponse<BehaviorItem>;

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
  isUnread: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
}

export interface MailSummary {
  unreadConversations: number;
  recentConversations: RecentConversation[];
  lastSyncAt: string | null;
}

export interface ConversationListItem {
  conversationId: string;
  subject: string;
  senderNamePreview: string;
  sendTime: string;
  isUnread: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  isHandled: boolean;
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

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  bodyHtmlSanitized: string;
  bodyTextPreview: string;
  sendTime: string;
  isUnread: boolean;
  recipients: MessageRecipient[];
  preventReply: boolean;
  sentViaEmail: boolean;
  sentViaSms: boolean;
}

export interface ConversationDetail {
  conversationId: string;
  subject: string;
  sendTime: string;
  isUnread: boolean;
  hasDrafts: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  isHandled: boolean;
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

export interface SourceHealthResponse {
  sources: SourceHealth[];
  overallState: FreshnessState;
  lastFullSyncAt: string | null;
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

// ─── Read State ────────────────────────────────────────────────────────────

export type ReadStateItemType = 'homework' | 'behavior' | 'mail_conversation' | 'feed_item';

export interface ReadStateRequest {
  itemType: ReadStateItemType;
  itemId: string;
  isRead: boolean;
  isHandled: boolean;
}

export interface ReadStateResponse {
  id: string;
  itemType: string;
  itemId: string;
  isRead: boolean;
  isHandled: boolean;
  updatedAt: string;
}

// ─── Sync ──────────────────────────────────────────────────────────────────

export interface SyncRefreshResponse {
  started: boolean;
  message: string;
}

// ─── Bulk Mail Actions ─────────────────────────────────────────────────────

export interface MailBulkActionRequest {
  conversationIds: string[];
}

export interface MailBulkActionResponse {
  updated: number;
}
