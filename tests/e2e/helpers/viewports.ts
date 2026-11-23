import type { Page } from '@playwright/test';

/**
 * The route list the responsive suite sweeps, and the API stubs that let every
 * one of them reach a rendered state without a seeded database.
 */

export const STUDENT_GUID = 'e2e-responsive-student-1';
export const CONVERSATION_ID = 'e2e-responsive-conversation-1';
export const HOMEWORK_ID = 'e2e-responsive-homework-1';
export const BEHAVIOR_ID = 'e2e-responsive-behavior-1';

export interface RouteUnderTest {
  /** For the test title. */
  name: string;
  path: string;
  /** The testid that means "this route has finished rendering". */
  readyTestId: string;
}

/**
 * All 13 pages. The child workspace appears twice on purpose: its timetable
 * section is a different layout from its list sections, and it is the one
 * surface with two presentations switched by CSS.
 */
export const ROUTES: RouteUnderTest[] = [
  { name: 'sign-in', path: '/auth/sign-in', readyTestId: 'sign-in-illustration' },
  { name: 'syncing', path: '/auth/syncing', readyTestId: 'syncing-heading' },
  { name: 'home', path: '/home', readyTestId: 'home-header' },
  { name: 'children', path: '/children', readyTestId: 'children-page' },
  {
    name: 'child workspace (homework)',
    path: `/children/${STUDENT_GUID}?section=homework`,
    readyTestId: 'child-workspace',
  },
  {
    name: 'child workspace (timetable)',
    path: `/children/${STUDENT_GUID}?section=timetable`,
    readyTestId: 'timetable-section',
  },
  {
    name: 'homework detail',
    path: `/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}`,
    readyTestId: 'homework-detail-page',
  },
  {
    name: 'behavior detail',
    path: `/children/${STUDENT_GUID}/behavior/${BEHAVIOR_ID}`,
    readyTestId: 'behavior-detail-page',
  },
  { name: 'inbox', path: '/inbox', readyTestId: 'inbox-page' },
  {
    name: 'conversation',
    path: `/inbox/${CONVERSATION_ID}`,
    readyTestId: 'conversation-page',
  },
  { name: 'more', path: '/more', readyTestId: 'more-page' },
  { name: 'add school', path: '/more/schools/new', readyTestId: 'add-school-page' },
  { name: 'telegram setup', path: '/more/telegram', readyTestId: 'telegram-setup-page' },
];

const NOW = new Date().toISOString();

const SCHOOLS = [
  {
    id: 'conn-responsive-1',
    semel: 540175,
    schoolName: 'תיכון עירוני א׳ רמת השרון',
    shortLabel: 'עירוני א׳',
    schoolYear: 2026,
  },
  {
    id: 'conn-responsive-2',
    semel: 440175,
    schoolName: 'בית הספר היסודי אלונים',
    shortLabel: 'אלונים',
    schoolYear: 2026,
  },
];

const CHILD = {
  studentGuid: STUDENT_GUID,
  privateName: 'מיקה',
  familyName: 'קורס',
  fullName: 'מיקה קורס',
  classCode: 'ז',
  classNum: 8,
  gender: 'F',
  isActive: true,
  recentHomeworkCount: 3,
  recentBehaviorCount: 1,
  positiveBehaviorCount: 2,
  neutralBehaviorCount: 1,
  subjectCount: 11,
  schoolId: SCHOOLS[0].id,
  schoolShortLabel: SCHOOLS[0].shortLabel,
  schoolName: SCHOOLS[0].schoolName,
  latestUpdateAt: NOW,
};

const SCHEDULE = {
  source: 'school',
  periods: [
    { lesson: 1, startTime: '08:00', endTime: '08:45' },
    { lesson: 2, startTime: '08:50', endTime: '09:35' },
    { lesson: 3, startTime: '09:45', endTime: '10:30' },
  ],
  breaks: [
    { afterLesson: 1, startTime: '08:45', endTime: '08:50', minutes: 5, kind: 'recess' },
    { afterLesson: 2, startTime: '09:35', endTime: '09:45', minutes: 10, kind: 'recess' },
  ],
};

/**
 * One lesson in every period on every school day, so the week grid has six
 * columns at 1280 and the agenda has a non-empty column whatever day it is.
 */
const TIMETABLE_ENTRIES = [1, 2, 3, 4, 5, 6].flatMap((day) =>
  [1, 2, 3].map((lesson) => ({
    id: `tt-${day}-${lesson}`,
    studentGuid: STUDENT_GUID,
    groupId: day * 100 + lesson,
    day,
    lesson,
    roomNum: `${200 + lesson}`,
    weeks: 1,
    groupName: `קבוצה ${lesson}`,
    subjectName: ['מתמטיקה', 'אנגלית', 'היסטוריה'][lesson - 1],
    teachers: [{ teacherGuid: `t-${day}-${lesson}`, teacherName: 'רונית לוי' }],
    updatedAt: NOW,
  })),
);

const EMPTY_PAGE = {
  data: [],
  pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
};

const HOMEWORK_ITEM = {
  id: HOMEWORK_ID,
  studentGuid: STUDENT_GUID,
  subjectName: 'מתמטיקה',
  teacherName: 'רונית לוי',
  homework: 'תרגילים 1-10 בעמוד 42',
  lessonDate: NOW,
  isNew: true,
  isArchived: false,
  syncedAt: NOW,
};

const BEHAVIOR_ITEM = {
  id: BEHAVIOR_ID,
  studentGuid: STUDENT_GUID,
  subjectName: 'אנגלית',
  teacherName: 'דנה כהן',
  eventType: 'איחור',
  bucket: 'negative',
  justified: false,
  lessonDate: NOW,
  isNew: true,
  isArchived: false,
  syncedAt: NOW,
};

const CONVERSATION = {
  id: CONVERSATION_ID,
  subject: 'הודעה מבית הספר על טיול שנתי',
  isNew: true,
  isArchived: false,
  hasAttachments: false,
  messageCount: 1,
  lastMessageAt: NOW,
  schoolId: SCHOOLS[0].id,
  schoolShortLabel: SCHOOLS[0].shortLabel,
  schoolName: SCHOOLS[0].schoolName,
  messages: [
    {
      id: 'msg-1',
      senderName: 'מזכירות בית הספר',
      sendTime: NOW,
      bodyHtml:
        '<p>הורים יקרים,</p><p>הטיול השנתי יתקיים בשבוע הבא. נא לשלוח אישור הורים.</p>',
      hasAttachments: false,
      files: [],
    },
  ],
};

/**
 * Every API call any of the 13 routes makes, answered from fixtures.
 *
 * Deliberately two connected schools: that is the configuration that renders
 * the chip rails and the school badges, which are the widest things on a 360px
 * screen and therefore the whole point of the overflow sweep.
 *
 * Order matters -- Playwright matches the LAST registered route first -- so the
 * catch-all goes on first and the specific patterns after it.
 */
export async function installApiStubs(page: Page): Promise<void> {
  // Catch-all: an endpoint nobody listed below still gets a well-formed empty
  // answer rather than a network error that would blank the page.
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({ json: { data: [] } });
  });

  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      json: {
        mashovUserId: 'e2e-parent-responsive',
        username: 'e2e-parent',
        displayName: 'דמיטרי קורס',
        childrenCount: 1,
        schools: SCHOOLS,
      },
    });
  });

  await page.route('**/api/v1/auth/schools', async (route) => {
    await route.fulfill({
      json: {
        data: SCHOOLS.map((school) => ({ semel: school.semel, name: school.schoolName })),
      },
    });
  });

  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({
      json: {
        freshness: { state: 'fresh', lastSyncAt: NOW, staleSources: [] },
        summary: {
          newConversations: 64,
          recentHomeworkCount: 3,
          recentBehaviorCount: 1,
          childrenCount: 1,
        },
        feed: [
          {
            id: 'feed-1',
            sourceType: 'homework',
            sourceId: HOMEWORK_ID,
            studentGuid: STUDENT_GUID,
            studentName: CHILD.fullName,
            title: 'שיעורי בית חדשים במתמטיקה',
            summary: 'תרגילים 1-10 בעמוד 42',
            category: 'homework',
            priority: 'medium',
            isPositive: false,
            isNew: true,
            isArchived: false,
            hasAttachments: false,
            linkPath: `/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}`,
            schoolId: SCHOOLS[0].id,
            schoolShortLabel: SCHOOLS[0].shortLabel,
            schoolName: SCHOOLS[0].schoolName,
            eventAt: NOW,
            syncedAt: NOW,
          },
        ],
        children: [CHILD],
      },
    });
  });

  await page.route('**/api/v1/feed**', async (route) => {
    await route.fulfill({ json: { data: [], pagination: EMPTY_PAGE.pagination } });
  });

  await page.route('**/api/v1/children', async (route) => {
    await route.fulfill({ json: { data: [CHILD] } });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}`, async (route) => {
    await route.fulfill({
      json: {
        student: {
          studentGuid: STUDENT_GUID,
          privateName: CHILD.privateName,
          familyName: CHILD.familyName,
          fullName: CHILD.fullName,
          classCode: CHILD.classCode,
          classNum: CHILD.classNum,
          gender: CHILD.gender,
          isActive: true,
        },
        summary: {
          recentHomeworkCount: 3,
          recentBehaviorCount: 1,
          positiveBehaviorCount: 2,
          neutralBehaviorCount: 1,
          subjectCount: 11,
          totalWeeklyHours: 18,
        },
        lastSyncAt: NOW,
      },
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/timetable`, async (route) => {
    await route.fulfill({ json: { data: TIMETABLE_ENTRIES, schedule: SCHEDULE } });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/homework/${HOMEWORK_ID}`)) {
      await route.fulfill({ json: HOMEWORK_ITEM });
      return;
    }
    await route.fulfill({ json: { ...EMPTY_PAGE, data: [HOMEWORK_ITEM] } });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/behavior/${BEHAVIOR_ID}`)) {
      await route.fulfill({ json: BEHAVIOR_ITEM });
      return;
    }
    await route.fulfill({ json: { ...EMPTY_PAGE, data: [BEHAVIOR_ITEM] } });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/subjects`, async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            id: 'subj-1',
            studentGuid: STUDENT_GUID,
            subjectName: 'מתמטיקה',
            weeklyHours: 5,
            teachers: [{ teacherGuid: 't-1', teacherName: 'רונית לוי' }],
          },
        ],
      },
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/notices`, async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            id: 'notice-1',
            studentGuid: STUDENT_GUID,
            eventText: '<p>יום ההורים יתקיים ביום שלישי בין 17:00 ל-20:00.</p>',
            expirationDate: NOW,
          },
        ],
      },
    });
  });

  await page.route('**/api/v1/mail/conversations**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/conversations/${CONVERSATION_ID}`)) {
      await route.fulfill({ json: CONVERSATION });
      return;
    }
    await route.fulfill({
      json: {
        data: [CONVERSATION],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      },
    });
  });

  await page.route('**/api/v1/mail/summary**', async (route) => {
    await route.fulfill({ json: { newConversations: 64, totalConversations: 1 } });
  });

  await page.route('**/api/v1/settings/source-health', async (route) => {
    await route.fulfill({
      json: {
        sources: [
          { source: 'homework', state: 'fresh', lastSyncAt: NOW, rowCount: 3 },
          { source: 'behavior', state: 'fresh', lastSyncAt: NOW, rowCount: 1 },
        ],
        contentFreshness: { state: 'fresh', lastContentAt: NOW, staleSources: [] },
      },
    });
  });

  await page.route('**/api/v1/settings/profile', async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            householdConnectionId: SCHOOLS[0].id,
            schoolName: SCHOOLS[0].schoolName,
            schoolShortLabel: SCHOOLS[0].shortLabel,
            displayName: 'דמיטרי קורס',
            email: 'parent@example.com',
            phone: '050-0000000',
          },
        ],
      },
    });
  });

  await page.route('**/api/v1/school-links', async (route) => {
    await route.fulfill({
      json: {
        data: SCHOOLS.map((school) => ({
          id: school.id,
          semel: school.semel,
          schoolName: school.schoolName,
          shortLabel: school.shortLabel,
          username: 'parent',
          childrenCount: 1,
          lastSyncAt: NOW,
        })),
      },
    });
  });

  await page.route('**/api/v1/digest/recipients**', async (route) => {
    await route.fulfill({ json: { data: [] } });
  });

  await page.route('**/api/v1/sync/status**', async (route) => {
    await route.fulfill({ json: { phase: 'idle', done: false, progress: 0 } });
  });
}
