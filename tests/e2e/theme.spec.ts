import { test, expect, type Page, type Route } from '@playwright/test';

const STUDENT_GUID = 'theme-student-guid-1';
const CONVERSATION_ID = 'theme-conversation-1';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockCoreRoutes(page: Page) {
  await page.route('**/api/v1/auth/me', (route) =>
    json(route, {
      mashovUserId: 'theme-user-1',
      username: 'theme-parent',
      displayName: 'Theme Parent',
      connectedSchool: { schoolName: 'Test School', schoolYear: 2026 },
    }),
  );

  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        unreadConversations: 1,
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
        childrenCount: 1,
      },
      feed: [],
      children: [
        {
          studentGuid: STUDENT_GUID,
          privateName: 'Test',
          familyName: 'Student',
          fullName: 'Test Student',
          classCode: 'א',
          classNum: 1,
          recentHomeworkCount: 1,
          recentBehaviorCount: 1,
          latestUpdateAt: new Date().toISOString(),
          oneLineStatus: 'ok',
        },
      ],
      school: { schoolName: 'Test School', schoolYear: 2026 },
    }),
  );

  await page.route('**/api/v1/children', (route) =>
    json(route, {
      data: [
        {
          studentGuid: STUDENT_GUID,
          privateName: 'Test',
          familyName: 'Student',
          fullName: 'Test Student',
          classCode: 'א',
          classNum: 1,
          gender: 'M',
          isActive: true,
          recentHomeworkCount: 1,
          recentBehaviorCount: 1,
          subjectCount: 3,
          latestUpdateAt: new Date().toISOString(),
        },
      ],
    }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}`, (route) =>
    json(route, {
      student: {
        studentGuid: STUDENT_GUID,
        privateName: 'Test',
        familyName: 'Student',
        fullName: 'Test Student',
        classCode: 'א',
        classNum: 1,
        gender: 'M',
        isActive: true,
      },
      summary: {
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
        subjectCount: 3,
        totalWeeklyHours: 10,
        attentionBehaviorCount: 1,
      },
      lastSyncAt: new Date().toISOString(),
    }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, (route) =>
    json(route, {
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, (route) =>
    json(route, {
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/subjects`, (route) =>
    json(route, { data: [] }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/notices`, (route) =>
    json(route, { data: [] }),
  );

  await page.route('**/api/v1/mail/summary', (route) =>
    json(route, {
      newConversations: 1,
      recentConversations: [],
      lastSyncAt: new Date().toISOString(),
    }),
  );

  await page.route('**/api/v1/mail/conversations**', (route) =>
    json(route, {
      data: [
        {
          conversationId: CONVERSATION_ID,
          subject: 'Theme test conversation',
          senderNamePreview: 'Teacher',
          sendTime: new Date().toISOString(),
          isNew: true,
          hasAttachments: false,
          preventReply: false,
          labels: [],
          lastFetchedAt: new Date().toISOString(),
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    }),
  );

  await page.route(`**/api/v1/mail/conversations/${CONVERSATION_ID}`, (route) =>
    json(route, {
      conversationId: CONVERSATION_ID,
      subject: 'Theme test conversation',
      sendTime: new Date().toISOString(),
      isNew: true,
      hasDrafts: false,
      hasAttachments: false,
      preventReply: false,
      labels: [],
      messages: [
        {
          messageId: 'msg-theme-1',
          conversationId: CONVERSATION_ID,
          senderId: 'sender-theme-1',
          senderName: 'Teacher',
          subject: 'Theme test conversation',
          bodyHtmlSanitized: '<p>Message body</p>',
          bodyTextPreview: 'Message body',
          sendTime: new Date().toISOString(),
          isNew: true,
          recipients: [],
          files: [],
          preventReply: false,
          sentViaEmail: false,
          sentViaSms: false,
        },
      ],
      lastFetchedAt: new Date().toISOString(),
    }),
  );

  await page.route('**/api/v1/settings/source-health', (route) =>
    json(route, {
      sources: [],
      overallState: 'fresh',
      lastFullSyncAt: null,
    }),
  );

  await page.route('**/api/v1/settings/profile', (route) =>
    json(route, {
      upstreamUserId: 'theme-user-1',
      displayName: 'Parent',
      email: 'parent@example.com',
      cellphone: '0500000000',
      schoolName: 'Test School',
      schoolYear: 2026,
      schoolCode: 1234,
      detailsState: 1,
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function isDarkMode(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains('dark'));
}

test.describe('Theme toggle', () => {
  test('toggles dark/light mode and persists on reload', async ({ page }) => {
    await mockCoreRoutes(page);

    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible();

    const initialIsDark = await isDarkMode(page);
    await toggle.click();

    await expect.poll(() => isDarkMode(page)).toBe(!initialIsDark);

    const expectedTheme = initialIsDark ? 'light' : 'dark';
    await expect.poll(() =>
      page.evaluate(() => window.localStorage.getItem('mashov.theme')),
    ).toBe(expectedTheme);

    await page.reload();
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect.poll(() => isDarkMode(page)).toBe(!initialIsDark);
  });

  test('keeps selected theme across navigation and shows toggle in major headers', async ({
    page,
  }) => {
    await mockCoreRoutes(page);

    await page.goto('/home');
    await expect(page.getByTestId('theme-toggle')).toBeVisible();

    if (!(await isDarkMode(page))) {
      await page.getByTestId('theme-toggle').click();
    }
    await expect.poll(() => isDarkMode(page)).toBe(true);

    const majorRoutes = [
      '/children',
      '/inbox',
      '/more',
      `/children/${STUDENT_GUID}?section=homework&behavior=all`,
      `/inbox/${CONVERSATION_ID}`,
    ];

    for (const route of majorRoutes) {
      await page.goto(route);
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
      await expect.poll(() => isDarkMode(page)).toBe(true);
    }
  });
});
