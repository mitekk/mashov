import { test, expect, type Page, type Route } from '@playwright/test';

const STUDENT_GUID = 'student-guid-1';
const CONVERSATION_ID = 'conv-1';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function childUrl(
  section: 'homework' | 'behavior' | 'subjects' | 'notices' = 'homework',
  behavior: 'all' | 'attention' | 'positive' | 'neutral' = 'all',
) {
  return `/children/${STUDENT_GUID}?section=${section}&behavior=${behavior}`;
}

async function mockBaseRoutes(page: Page) {
  await page.route('**/api/v1/auth/me', (route) =>
    json(route, {
      mashovUserId: 'nav-user-1',
      username: 'nav-parent',
      displayName: 'Navigation Parent',
      connectedSchool: { schoolName: 'Test School', schoolYear: 2026 },
      schools: [
        {
          id: 'conn-mock-1',
          semel: 540175,
          schoolName: 'Test School',
          shortLabel: 'Test School',
          schoolYear: 2026,
        },
      ],
    }),
  );

  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        newConversations: 1,
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
        childrenCount: 1,
      },
      feed: [
        {
          id: 'feed-1',
          sourceType: 'homework',
          sourceId: 'hw-1',
          studentGuid: STUDENT_GUID,
          studentName: 'Test Student',
          title: 'Homework update',
          summary: 'New homework',
          category: 'homework',
          priority: 'medium',
          isPositive: false,
          isNew: true,
          isArchived: false,
          hasAttachments: false,
          eventAt: new Date().toISOString(),
          syncedAt: new Date().toISOString(),
          linkPath: `/children/${STUDENT_GUID}`,
        },
      ],
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
          oneLineStatus: '1 homework',
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
          subjectCount: 1,
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
        subjectCount: 1,
        totalWeeklyHours: 5,
        attentionBehaviorCount: 1,
      },
      lastSyncAt: new Date().toISOString(),
    }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/hw-1`)) {
      return json(route, {
        id: 'hw-1',
        studentGuid: STUDENT_GUID,
        lessonId: 1,
        groupId: 1,
        lessonDate: new Date().toISOString(),
        lesson: 2,
        subjectName: 'Math',
        homeworkText: 'New homework',
        remark: null,
        files: [],
        isNew: false,
        isArchived: false,
        updatedAt: new Date().toISOString(),
      });
    }
    return json(route, {
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/children/${STUDENT_GUID}/behavior/beh-1`)) {
      return json(route, {
        id: 'beh-1',
        studentGuid: STUDENT_GUID,
        lessonId: 1,
        groupId: 1,
        eventCode: 2,
        achvaCode: 2,
        achvaName: 'Absence',
        bucket: 'attention',
        priority: 'high',
        justifiable: false,
        lessonDate: new Date().toISOString(),
        lesson: 2,
        subject: 'Math',
        reporter: 'Teacher',
        remark: null,
        justification: null,
        eventAt: new Date().toISOString(),
        isNew: false,
        isArchived: false,
        updatedAt: new Date().toISOString(),
      });
    }
    return json(route, {
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  });

  await page.route(`**/api/v1/children/${STUDENT_GUID}/subjects`, (route) =>
    json(route, { data: [] }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/notices`, (route) =>
    json(route, { data: [] }),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/releases`, (route) =>
    json(route, []),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/school-activities`, (route) =>
    json(route, []),
  );

  await page.route(`**/api/v1/children/${STUDENT_GUID}/releases/*`, (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 204 });
    }
    return json(route, {});
  });

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
          subject: 'Message subject',
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
      subject: 'Message subject',
      sendTime: new Date().toISOString(),
      isNew: true,
      hasDrafts: false,
      hasAttachments: false,
      preventReply: false,
      labels: [],
      messages: [
        {
          messageId: 'msg-1',
          conversationId: CONVERSATION_ID,
          senderId: 'sender-1',
          senderName: 'Teacher',
          subject: 'Message subject',
          bodyHtmlSanitized: '<p>Hello world</p>',
          bodyTextPreview: 'Hello world',
          sendTime: new Date().toISOString(),
          isNew: true,
          recipients: [],
          preventReply: false,
          sentViaEmail: false,
          sentViaSms: false,
        },
      ],
      lastFetchedAt: new Date().toISOString(),
    }),
  );

  // `/more` lists the household's schools, so the page needs this route as
  // much as it needs source-health. An unmocked 401 here is indistinguishable
  // from an expired session and the client bounces to sign-in.
  await page.route('**/api/v1/school-links', (route) =>
    json(route, {
      data: [
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'Test School',
          shortLabel: 'Test School',
          schoolYear: 2026,
          username: 'parent',
          childrenCount: 1,
          isPrimary: true,
          lastLoginAt: new Date().toISOString(),
          lastSyncAt: new Date().toISOString(),
          active: true,
        },
      ],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
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
    json(route, [
      {
        householdConnectionId: 'conn-1',
        upstreamUserId: 'user-1',
        displayName: 'Parent',
        email: 'parent@example.com',
        cellphone: '0500000000',
        schoolName: 'Test School',
        schoolYear: 2026,
        schoolCode: 1234,
        detailsState: 1,
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  await page.route('**/api/v1/sync/refresh', (route) =>
    json(route, { started: true, message: 'ok' }, 202),
  );
}

test.describe('Navigation and fallback hardening', () => {
  test('opens dedicated homework detail page from home feed', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();

    await page.getByTestId('feed-item-feed-1').locator('a').click();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-page')).toBeVisible();
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();
  });

  test('supports core click/navigation flows across Home -> Child -> Inbox -> Conversation -> More', async ({
    page,
  }) => {
    await mockBaseRoutes(page);

    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();

    await page.getByTestId(`child-card-${STUDENT_GUID}`).click();
    await expect(page).toHaveURL(childUrl('homework'));
    await expect(page.getByTestId('child-workspace')).toBeVisible();

    await page.getByTestId('nav-inbox').click();
    await expect(page).toHaveURL('/inbox');
    await expect(page.getByTestId('inbox-page')).toBeVisible();

    await page.getByTestId(`conversation-item-${CONVERSATION_ID}`).click();
    await expect(page).toHaveURL(`/inbox/${CONVERSATION_ID}`);
    await expect(page.getByTestId('conversation-page')).toBeVisible();

    await page.getByTestId('nav-more').click();
    await expect(page).toHaveURL('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();
  });

  test('renders child workspace from legacy payload and keeps section/filter in query params', async ({
    page,
  }) => {
    await mockBaseRoutes(page);

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
        homework: [],
        behavior: [],
        subjects: [],
        notices: [],
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
        data: [
          {
            id: 'beh-1',
            studentGuid: STUDENT_GUID,
            lessonId: 1,
            groupId: 1,
            eventCode: 2,
            achvaCode: 2,
            achvaName: 'Absence',
            classification: 'attention',
            justifiable: false,
            lessonDate: new Date().toISOString(),
            lesson: 2,
            subject: 'Math',
            reporter: 'Teacher',
            remark: null,
            justification: null,
            eventAt: new Date().toISOString(),
            isNew: false,
            isArchived: false,
            updatedAt: new Date().toISOString(),
          },
        ],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      }),
    );
    await page.route(`**/api/v1/children/${STUDENT_GUID}/subjects`, (route) =>
      json(route, [
        {
          id: 'sub-1',
          studentGuid: STUDENT_GUID,
          groupId: 1,
          groupName: 'Math',
          subjectName: 'Math',
          teachers: [],
          inactiveTeachers: [],
          weeklyHours: 4,
          lessonsCount: 10,
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    await page.route(`**/api/v1/children/${STUDENT_GUID}/notices`, (route) =>
      json(route, [
        {
          id: 'notice-1',
          studentGuid: STUDENT_GUID,
          eventId: 1,
          eventText: '<p>Hello</p>',
          expirationDate: new Date().toISOString(),
          inSite: true,
          updatedAt: new Date().toISOString(),
        },
      ]),
    );

    await page.goto(`/children/${STUDENT_GUID}`);
    await expect(page.getByTestId('child-workspace')).toBeVisible();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Test Student');

    await page.getByTestId('section-tab-behavior').click();
    await expect(page).toHaveURL(childUrl('behavior'));
    await expect(page.getByTestId('behavior-section')).toBeVisible();
    await expect(page.getByTestId('behavior-item-beh-1')).toBeVisible();

    await page.getByTestId('behavior-filter-positive').click();
    await expect(page).toHaveURL(childUrl('behavior', 'positive'));

    await page.getByTestId('section-tab-subjects').click();
    await expect(page).toHaveURL(childUrl('subjects', 'positive'));
    await expect(page.getByTestId('subjects-section')).toBeVisible();

    await page.getByTestId('section-tab-notices').click();
    await expect(page).toHaveURL(childUrl('notices', 'positive'));
    await expect(page.getByTestId('notices-section')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(childUrl('subjects', 'positive'));
    await expect(page.getByTestId('subjects-section')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(childUrl('behavior', 'positive'));
    await expect(page.getByTestId('behavior-section')).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(childUrl('subjects', 'positive'));
  });

  test('uses replace history for behavior filter changes without full page reloads', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.goto(childUrl('homework'));
    await expect(page.getByTestId('child-workspace')).toBeVisible();
    await expect(page.getByTestId('homework-section')).toBeVisible();

    const initialDocumentMarker = await page.evaluate(() => {
      window.sessionStorage.setItem('__child_workspace_unload_count', '0');
      window.addEventListener('beforeunload', () => {
        const current = Number(
          window.sessionStorage.getItem('__child_workspace_unload_count') ?? '0',
        );
        window.sessionStorage.setItem('__child_workspace_unload_count', String(current + 1));
      });
      const marker = typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `marker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      (window as Window & { __childWorkspaceDocumentMarker?: string }).__childWorkspaceDocumentMarker = marker;
      return marker;
    });

    await page.getByTestId('section-tab-behavior').click();
    await expect(page).toHaveURL(childUrl('behavior'));
    await expect(page.getByTestId('behavior-section')).toBeVisible();

    await page.getByTestId('behavior-filter-attention').click();
    await expect(page).toHaveURL(childUrl('behavior', 'attention'));

    await page.getByTestId('behavior-filter-positive').click();
    await expect(page).toHaveURL(childUrl('behavior', 'positive'));

    await page.getByTestId('section-tab-subjects').click();
    await expect(page).toHaveURL(childUrl('subjects', 'positive'));

    await page.goBack();
    await expect(page).toHaveURL(childUrl('behavior', 'positive'));

    await page.goBack();
    await expect(page).toHaveURL(childUrl('homework'));

    const unloadCount = await page.evaluate(
      () => window.sessionStorage.getItem('__child_workspace_unload_count'),
    );
    expect(unloadCount).toBe('0');

    const finalDocumentMarker = await page.evaluate(
      () => (window as Window & { __childWorkspaceDocumentMarker?: string }).__childWorkspaceDocumentMarker,
    );
    expect(finalDocumentMarker).toBe(initialDocumentMarker);
  });

  test('renders section/filter from deep-link query params', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.goto(childUrl('behavior', 'attention'));
    await expect(page.getByTestId('child-workspace')).toBeVisible();
    await expect(page).toHaveURL(childUrl('behavior', 'attention'));
    await expect(page.getByTestId('behavior-section')).toBeVisible();
  });

  test('legacy /children/:studentGuid/:section route no longer resolves', async ({ page }) => {
    await mockBaseRoutes(page);

    const response = await page.goto(`/children/${STUDENT_GUID}/behavior`);
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('child-workspace')).toHaveCount(0);
  });

  test('renders children tab in bottom nav', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-page')).toBeVisible();
    await expect(page.getByTestId('nav-children')).toBeVisible();
  });

  test('renders conversation detail from legacy nested payload with subject/body fallback', async ({
    page,
  }) => {
    await mockBaseRoutes(page);

    await page.route('**/api/v1/mail/summary', (route) =>
      json(route, { unreadConversations: 1, recentConversations: [], lastSyncAt: null }),
    );
    await page.route('**/api/v1/mail/conversations**', (route) =>
      json(route, {
        data: [
          {
            conversationId: CONVERSATION_ID,
            subject: 'Legacy subject',
            senderNamePreview: 'Teacher',
            sendTime: new Date().toISOString(),
            isUnread: true,
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
        conversation: {
          conversationId: CONVERSATION_ID,
          subject: '',
          sendTime: new Date().toISOString(),
          isUnread: true,
          hasDrafts: false,
          hasAttachments: false,
          preventReply: false,
          labels: [],
          lastFetchedAt: new Date().toISOString(),
        },
        messages: [
          {
            messageId: 'msg-1',
            conversationId: CONVERSATION_ID,
            senderId: 'sender-1',
            senderName: 'Teacher',
            subject: '',
            bodyHtmlSanitized: null,
            bodyTextPreview: null,
            sendTime: new Date().toISOString(),
            isUnread: true,
            recipients: [],
            files: [],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ],
      }),
    );

    await page.goto('/inbox');
    await page.getByTestId(`conversation-item-${CONVERSATION_ID}`).click();
    await expect(page).toHaveURL(`/inbox/${CONVERSATION_ID}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('ללא נושא');
    await expect(page.getByText('תוכן ההודעה אינו זמין בשלב 1.')).toBeVisible();
  });

  test('disables unsupported out-of-phase links instead of navigating', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.route('**/api/v1/dashboard', (route) =>
      json(route, {
        freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
        summary: {
          unreadConversations: 0,
          recentHomeworkCount: 0,
          recentBehaviorCount: 0,
          childrenCount: 0,
        },
        feed: [
          {
            id: 'feed-out',
            sourceType: 'mail',
            sourceId: 'x',
            studentGuid: null,
            studentName: null,
            title: 'Out of phase',
            summary: 'Unsupported path',
            category: 'mail',
            priority: 'medium',
            isPositive: false,
            isNew: true,
            isArchived: false,
            hasAttachments: false,
            eventAt: new Date().toISOString(),
            syncedAt: new Date().toISOString(),
            linkPath: '/timetable',
          },
        ],
        children: [],
        school: { schoolName: 'Test', schoolYear: 2026 },
      }),
    );
    await page.route('**/api/v1/sync/refresh', (route) =>
      json(route, { started: true, message: 'ok' }, 202),
    );

    await page.goto('/home');
    await expect(page.getByTestId('feed-item-disabled-feed-out')).toBeVisible();

    await page.getByTestId('feed-item-disabled-feed-out').click();
    await expect(page).toHaveURL('/home');
  });

});
