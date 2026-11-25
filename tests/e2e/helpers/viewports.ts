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
 * Every page. The child workspace appears twice on purpose: its timetable
 * section is a different layout from its list sections, and it is the one
 * surface with two presentations switched by CSS.
 *
 * The four credential-recovery routes read their state from the query string,
 * so they are given plausible ids here. The APIs behind them answer 404 from
 * the catch-all, which is fine -- this sweep measures geometry, and an error
 * state is laid out by the same shell as a loaded one.
 */
export const ROUTES: RouteUnderTest[] = [
  { name: 'sign-in', path: '/auth/sign-in', readyTestId: 'sign-in-illustration' },
  { name: 'syncing', path: '/auth/syncing', readyTestId: 'syncing-heading' },
  {
    name: 'forgot password',
    path: '/auth/forgot-password',
    readyTestId: 'forgot-password-id-number',
  },
  // `rid` and `cid`, not the longhand the page objects' METHOD names suggest:
  // both screens fall through to their "this is no longer valid" state on any
  // other key, which renders no form at all.
  {
    name: 'reset password',
    path: '/auth/reset-password?rid=e2e-recovery-1&semel=540175',
    readyTestId: 'reset-password-code',
  },
  {
    name: 'mfa',
    path: '/auth/mfa?cid=e2e-challenge-1&semel=540175',
    readyTestId: 'mfa-code',
  },
  {
    name: 'complete setup',
    path: '/auth/complete-setup?semel=540175&username=parent',
    readyTestId: 'complete-setup-submit',
  },
  { name: 'home', path: '/home', readyTestId: 'home-header' },
  { name: 'children', path: '/children', readyTestId: 'children-page' },
  {
    name: 'child workspace (homework)',
    path: `/children/${STUDENT_GUID}?section=homework`,
    readyTestId: 'child-workspace',
  },
  {
    name: 'child workspace (behavior)',
    path: `/children/${STUDENT_GUID}?section=behavior`,
    readyTestId: 'behavior-section',
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

/**
 * The ISO date of `schoolDay` (1 = Sunday) in the CURRENT week.
 *
 * Plans and lesson history are filtered against `getCurrentWeekDates()`, so a
 * fixed date would be silently dropped and the notes would never render.
 */
function weekDateFor(schoolDay: number): string {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  sunday.setHours(12, 0, 0, 0);
  const date = new Date(sunday);
  date.setDate(sunday.getDate() + (schoolDay - 1));
  return date.toISOString();
}

const SCHOOLS = [
  {
    id: 'conn-responsive-1',
    semel: 540175,
    schoolName: 'תיכון עירוני א׳ רמת השרון',
    // Deliberately long. The chip rails and SchoolBadge's truncation caps are
    // the widest things on a 360px screen; a short label tests neither.
    shortLabel: 'תיכון עירוני א׳ ע״ש רמת השרון',
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

/**
 * Must match `HomeworkItem` in `frontend/src/types/api.ts`. This sweep measures
 * what a 360px screen does with real content, so a fixture missing half the
 * contract measures a near-empty card and proves nothing.
 */
const HOMEWORK_ITEM = {
  id: HOMEWORK_ID,
  studentGuid: STUDENT_GUID,
  lessonId: 9101,
  groupId: 7201,
  lessonDate: NOW,
  lesson: 3,
  subjectName: 'מתמטיקה',
  homeworkText: 'תרגילים 1-10 בעמוד 42',
  remark: 'להביא מחשבון ומחוגה לשיעור הבא',
  files: [],
  isNew: true,
  isArchived: false,
  isPastYear: false,
  updatedAt: NOW,
};

/**
 * Must match `BehaviorItem` in `frontend/src/types/api.ts`.
 *
 * `achvaCode: 1` is what `BEHAVIOR_MAP` classifies as `attention`, so the
 * fixture agrees with the classifier instead of contradicting it.
 */
const BEHAVIOR_ITEM = {
  id: BEHAVIOR_ID,
  studentGuid: STUDENT_GUID,
  lessonId: 9102,
  groupId: 7202,
  eventCode: 1,
  achvaCode: 1,
  achvaName: 'איחור',
  bucket: 'attention',
  priority: 'medium',
  justifiable: false,
  lessonDate: NOW,
  lesson: 2,
  subject: 'אנגלית',
  reporter: 'דנה כהן',
  remark: 'הגיע באיחור של 15 דקות לשיעור',
  justification: null,
  files: [],
  eventAt: NOW,
  isNew: true,
  isArchived: false,
  isPastYear: false,
  updatedAt: NOW,
};

/**
 * School-sent HTML as it really arrives: a table pasted out of Office with a
 * hard pixel width, and an image with fixed `width`/`height` attributes.
 *
 * This is the single most likely source of a real 360px overflow, and the
 * reason `.prose-rtl` grew `:where(img,video,iframe){max-width:100%}` and
 * `:where(table){display:block;width:max-content;max-width:100%;overflow-x:auto}`.
 * A fixture of two bare <p>s would load neither guard.
 */
const SCHOOL_HTML = [
  '<p>הורים יקרים,</p>',
  '<p>הטיול השנתי יתקיים בשבוע הבא. נא לשלוח אישור הורים חתום עד יום חמישי.</p>',
  '<table border="1" cellpadding="6" style="width:900px;border-collapse:collapse">',
  '<tr><th>יום</th><th>שעת יציאה</th><th>שעת חזרה</th><th>יעד</th><th>עלות</th><th>הערות</th></tr>',
  '<tr><td>ראשון</td><td>07:30</td><td>18:00</td><td>מצדה ומצוק הארבל</td><td>180 ש״ח</td>',
  '<td>יש להביא כובע, שתייה מרובה ונעליים סגורות</td></tr>',
  '<tr><td>שני</td><td>08:00</td><td>17:30</td><td>עין גדי</td><td>כלול</td>',
  '<td>בגד ים ומגבת</td></tr>',
  '</table>',
  '<p><img src="/favicon.svg" width="1200" height="400" alt="מפת הטיול"></p>',
].join('');

const CONVERSATION = {
  conversationId: CONVERSATION_ID,
  subject: 'הודעה מבית הספר על טיול שנתי',
  sendTime: NOW,
  isNew: true,
  isArchived: false,
  hasDrafts: false,
  hasAttachments: true,
  preventReply: false,
  labels: [],
  lastFetchedAt: NOW,
  messageCount: 1,
  lastMessageAt: NOW,
  schoolId: SCHOOLS[0].id,
  schoolShortLabel: SCHOOLS[0].shortLabel,
  schoolName: SCHOOLS[0].schoolName,
  messages: [
    {
      messageId: 'msg-1',
      conversationId: CONVERSATION_ID,
      senderId: 'sender-1',
      senderName: 'מזכירות בית הספר',
      subject: 'הודעה מבית הספר על טיול שנתי',
      // `bodyHtmlSanitized`, not `bodyHtml`: MessageBubble falls back to
      // "תוכן ההודעה אינו זמין בשלב 1" for anything else, which renders none
      // of the prose guards above.
      bodyHtmlSanitized: SCHOOL_HTML,
      bodyTextPreview: 'הטיול השנתי יתקיים בשבוע הבא.',
      sendTime: NOW,
      isNew: true,
      recipients: [],
      files: [{ fileId: 'file-1', fileName: 'אישור-הורים-לטיול-שנתי-2026.pdf' }],
      hasAttachments: true,
      preventReply: false,
      sentViaEmail: false,
      sentViaSms: false,
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
 *
 * RESPONSE SHAPES ARE NOT UNIFORM, and the API function's return type is NOT
 * the wire shape -- several of them unwrap. `/auth/schools`,
 * `/settings/profile`, `/children/:guid/releases` and
 * `/children/:guid/school-activities` answer with a BARE ARRAY; everything
 * else, `/school-links` included, answers `{ data: [...] }`. Read the function
 * body, not its signature: `fetchSchoolLinks(): Promise<SchoolLink[]>` returns
 * `response.data`.
 *
 * Getting it wrong does not fail honestly in either direction. A `{ data: [] }`
 * served where an array is expected reaches `schools.slice(...)` or
 * `activities.filter(...)` and throws "is not a function" during render --
 * and because the readiness testid may paint before the query resolves, that
 * shows up as a FLAKY test on one project rather than a broken fixture. An
 * array served where `{ data }` is expected is quieter still: the section
 * simply never renders, and the overflow sweep passes over a page with less on
 * it than it should have.
 */
export async function installApiStubs(page: Page): Promise<void> {
  // Catch-all: deliberately a 404 rather than a plausible-looking empty body.
  // An unstubbed endpoint then renders this app's error state, which is
  // visible and harmless, instead of handing a component the wrong shape.
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'not stubbed in viewports.ts', details: [] } },
    });
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

  // Bare array: getSchools() returns School[], not { data }.
  await page.route('**/api/v1/auth/schools', async (route) => {
    await route.fulfill({
      json: SCHOOLS.map((school) => ({ semel: school.semel, name: school.schoolName })),
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

  // Bare array: fetchProfile() returns ParentProfile[].
  await page.route('**/api/v1/settings/profile', async (route) => {
    await route.fulfill({
      json: [
        {
          householdConnectionId: SCHOOLS[0].id,
          schoolName: SCHOOLS[0].schoolName,
          schoolShortLabel: SCHOOLS[0].shortLabel,
          displayName: 'דמיטרי קורס',
          email: 'parent@example.com',
          phone: '050-0000000',
        },
      ],
    });
  });

  // `{ data }`, despite fetchSchoolLinks() returning SchoolLink[] -- it
  // unwraps. The signature is not the wire shape; read the function.
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

  // Bare arrays again, and ChildHeader asks for activities on MOUNT (not when
  // its dialog opens), so an unstubbed one crashes the whole workspace.
  // Non-empty, so both dialogs have something to show and `.dialog-panel` is
  // reachable from a test rather than only asserted as a class string.
  await page.route(`**/api/v1/children/${STUDENT_GUID}/school-activities`, async (route) => {
    await route.fulfill({
      json: [
        {
          id: 'activity-1',
          studentGuid: STUDENT_GUID,
          title: 'אישור השתתפות בטיול השנתי לאזור ים המלח ומצדה',
          isAnswered: false,
          answer: null,
          dueDate: NOW,
        },
      ],
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/releases`, async (route) => {
    await route.fulfill({ json: [] });
  });

  // A long plan note on a real lesson, not an empty list. `LessonDetails` is
  // the thing that inflates a week-grid row at 11px inside a 144px cell -- the
  // agenda's whole justification, and the only input that exercises the grid's
  // `md:line-clamp-3 lg:line-clamp-none`.
  await page.route(`**/api/v1/children/${STUDENT_GUID}/lessons/plans`, async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            lessondate: weekDateFor(1),
            lesson: 1,
            groupid: 101,
            plan: 'חזרה על כל החומר של הפרק: משוואות ממעלה ראשונה, אי-שוויונות, ובעיות מילוליות. יש להביא מחברת, מחשבון ואת דף הנוסחאות שחולק בשיעור הקודם.',
          },
        ],
      },
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/lessons/history`, async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            lessonLog: {
              lessonDate: weekDateFor(1),
              lesson: 1,
              groupId: 101,
              remark: 'התלמידה השתתפה יפה בשיעור והציגה פתרון בפני הכיתה.',
              homeWork: 'תרגילים 1 עד 14 בעמוד 42, ולהשלים את מה שלא הספקנו בכיתה.',
            },
          },
        ],
      },
    });
  });

  await page.route('**/api/v1/digest/telegram-links/**', async (route) => {
    await route.fulfill({ json: { state: 'pending', code: 'e2e-code' } });
  });

  await page.route('**/api/v1/sync/status**', async (route) => {
    await route.fulfill({ json: { phase: 'idle', done: false, progress: 0 } });
  });
}
