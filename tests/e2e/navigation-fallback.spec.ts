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
  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        unreadConversations: 1,
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
        childrenCount: 1,
      },
      needsAttention: [
        {
          id: 'att-1',
          type: 'unread_conversation',
          title: 'Unread conversation',
          summary: 'Summary',
          studentGuid: null,
          studentName: null,
          timestamp: new Date().toISOString(),
          linkPath: `/inbox/${CONVERSATION_ID}`,
        },
      ],
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
          isUnread: true,
          isHandled: false,
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
      unreadConversations: 1,
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
          isUnread: true,
          hasAttachments: false,
          preventReply: false,
          labels: [],
          isHandled: false,
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
      isUnread: true,
      hasDrafts: false,
      hasAttachments: false,
      preventReply: false,
      labels: [],
      isHandled: false,
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
          isUnread: true,
          recipients: [],
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
      upstreamUserId: 'user-1',
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
  await page.route('**/api/v1/sync/refresh', (route) =>
    json(route, { started: true, message: 'ok' }, 202),
  );
  await page.route('**/api/v1/read-state', (route) =>
    json(route, {
      id: 'rs-1',
      itemType: 'feed_item',
      itemId: 'feed-1',
      isRead: true,
      isHandled: true,
      updatedAt: new Date().toISOString(),
    }, 201),
  );
}

test.describe('Navigation and fallback hardening', () => {
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

    await page.getByTestId('nav-children').click();
    await expect(page).toHaveURL(childUrl('homework'));
    await expect(page.getByTestId('child-workspace')).toBeVisible();
  });

  test('renders child workspace from legacy payload and keeps section/filter in query params', async ({
    page,
  }) => {
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
            isHandled: false,
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
      const marker = window.crypto.randomUUID();
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

  test('falls back to /children when selected child does not exist', async ({ page }) => {
    await mockBaseRoutes(page);

    await page.addInitScript(() => {
      window.localStorage.setItem('mashov.selectedChildGuid', 'missing-guid');
    });

    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-page')).toBeVisible();

    await page.getByTestId('nav-children').click();
    await expect(page).toHaveURL('/children');
  });

  test('renders conversation detail from legacy nested payload with subject/body fallback', async ({
    page,
  }) => {
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
            isHandled: false,
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
    await page.route('**/api/v1/dashboard', (route) =>
      json(route, {
        freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
        summary: {
          unreadConversations: 0,
          recentHomeworkCount: 0,
          recentBehaviorCount: 0,
          childrenCount: 0,
        },
        needsAttention: [
          {
            id: 'att-out',
            type: 'sync_degraded',
            title: 'Out of phase',
            summary: 'Unsupported path',
            studentGuid: null,
            studentName: null,
            timestamp: new Date().toISOString(),
            linkPath: '/grades',
          },
        ],
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
            isUnread: true,
            isHandled: false,
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
    await expect(page.getByTestId('attention-card-disabled-att-out')).toBeVisible();
    await expect(page.getByTestId('feed-item-disabled-feed-out')).toBeVisible();

    await page.getByTestId('attention-card-disabled-att-out').click();
    await expect(page).toHaveURL('/home');

    await page.getByTestId('feed-item-disabled-feed-out').click();
    await expect(page).toHaveURL('/home');
  });

  test('clear read-state action sends clearAll payload', async ({ page }) => {
    let capturedPayload: unknown = null;

    await page.route('**/api/v1/settings/source-health', (route) =>
      json(route, { sources: [], overallState: 'fresh', lastFullSyncAt: null }),
    );
    await page.route('**/api/v1/settings/profile', (route) =>
      json(route, {
        upstreamUserId: 'user-1',
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
    await page.route('**/api/v1/dashboard', (route) =>
      json(route, {
        freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
        summary: {
          unreadConversations: 0,
          recentHomeworkCount: 0,
          recentBehaviorCount: 0,
          childrenCount: 0,
        },
        needsAttention: [],
        feed: [],
        children: [],
        school: { schoolName: 'Test', schoolYear: 2026 },
      }),
    );
    await page.route('**/api/v1/read-state', async (route) => {
      capturedPayload = route.request().postDataJSON();
      await json(route, { deleted: 4 }, 201);
    });

    await page.goto('/more');
    await expect(page.getByTestId('clear-read-state-button')).toBeVisible();
    await page.getByTestId('clear-read-state-button').click();

    expect(capturedPayload).toEqual({ clearAll: true });
  });
});
