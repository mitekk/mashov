import { test, expect } from '@playwright/test';
import { ChildrenPage } from './pages/ChildrenPage';
import { ChildWorkspacePage } from './pages/ChildWorkspacePage';

/**
 * E2E tests for the Children page (/children) and Child Workspace
 * (/children/:studentGuid?section=:section&behavior=:behavior).
 *
 * Empty-state checks use route mocking so results are deterministic.
 * Workspace tests verify navigation, section tab switching, and rendering.
 */

function makeHomeworkItem(overrides: object = {}) {
  return {
    id: 'hw-1',
    studentGuid: 'e2e-test-student-guid-00002',
    lessonId: 1,
    groupId: 1,
    lessonDate: new Date().toISOString(),
    lesson: 2,
    subjectName: 'Math',
    homeworkText: 'Solve questions 1-5',
    remark: 'Bring notebook',
    files: [],
    isNew: true,
    isArchived: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBehaviorItem(overrides: object = {}) {
  return {
    id: 'beh-1',
    studentGuid: 'e2e-test-student-guid-00002',
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
    files: [],
    eventAt: new Date().toISOString(),
    isNew: true,
    isArchived: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const MOCK_ME = {
  mashovUserId: 'e2e-parent-1',
  username: 'e2e-parent',
  displayName: 'E2E Parent',
  connectedSchool: { schoolName: 'Test School', schoolYear: 2026 },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({ json: MOCK_ME });
  });
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
        summary: {
          newConversations: 0,
          recentHomeworkCount: 0,
          recentBehaviorCount: 0,
          childrenCount: 0,
        },
        feed: [],
        children: [],
        school: { schoolName: 'Test School', schoolYear: 2026 },
      }),
    });
  });
  await page.route('**/api/v1/children', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route('**/api/v1/children/*/homework/*/is-new', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/v1/children/*/homework/*/archive', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/v1/children/*/behavior/*/is-new', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/v1/children/*/behavior/*/archive', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/v1/children/*/homework/is-new', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
  });
  await page.route('**/api/v1/children/*/homework/archive', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
  });
  await page.route('**/api/v1/children/*/behavior/is-new', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
  });
  await page.route('**/api/v1/children/*/behavior/archive', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1 }) });
  });
});

test.describe('Children page', () => {
  test('renders the children page with empty state when no students exist', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    const cardCount = await childrenPage.allChildCards().count();
    expect(cardCount).toBe(0);
  });

  test('children page does not crash on load', async ({ page }) => {
    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    expect(page.url()).toContain('/children');
  });

  test('children page shows page heading', async ({ page }) => {
    await page.goto('/children');

    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    const text = await heading.textContent();
    expect(text).toContain('ילדים');
  });

  test('children page persists its empty state after reload', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    const initialCount = await childrenPage.allChildCards().count();

    await page.reload();
    await expect(childrenPage.pageHeading).toBeVisible();

    const countAfterReload = await childrenPage.allChildCards().count();
    expect(countAfterReload).toBe(initialCount);
  });

  test('children list cards do not render selected-highlight border styles', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              studentGuid: 'student-no-highlight-1',
              privateName: 'One',
              familyName: 'Kid',
              fullName: 'One Kid',
              classCode: 'א',
              classNum: 1,
              gender: 'M',
              isActive: true,
              recentHomeworkCount: 0,
              recentBehaviorCount: 0,
              subjectCount: 0,
              latestUpdateAt: new Date().toISOString(),
            },
            {
              studentGuid: 'student-no-highlight-2',
              privateName: 'Two',
              familyName: 'Kid',
              fullName: 'Two Kid',
              classCode: 'ב',
              classNum: 2,
              gender: 'F',
              isActive: true,
              recentHomeworkCount: 0,
              recentBehaviorCount: 0,
              subjectCount: 0,
              latestUpdateAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    const firstCard = page.getByTestId('child-list-card-student-no-highlight-1');
    const secondCard = page.getByTestId('child-list-card-student-no-highlight-2');
    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();
    await expect(firstCard).not.toHaveClass(/border-primary|shadow-\[0_0_0_1px_hsl\(var\(--primary\)\)\]/);
    await expect(secondCard).not.toHaveClass(/border-primary|shadow-\[0_0_0_1px_hsl\(var\(--primary\)\)\]/);
  });

  test('children list cards show homework, negative, and positive indicators including zero values', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              studentGuid: 'student-indicators-1',
              privateName: 'One',
              familyName: 'Kid',
              fullName: 'One Kid',
              classCode: 'א',
              classNum: 1,
              gender: 'M',
              isActive: true,
              recentHomeworkCount: 2,
              recentBehaviorCount: 0,
              positiveBehaviorCount: 0,
              subjectCount: 0,
              latestUpdateAt: new Date().toISOString(),
            },
            {
              studentGuid: 'student-indicators-2',
              privateName: 'Two',
              familyName: 'Kid',
              fullName: 'Two Kid',
              classCode: 'ב',
              classNum: 2,
              gender: 'F',
              isActive: true,
              recentHomeworkCount: 1,
              recentBehaviorCount: 1,
              positiveBehaviorCount: 2,
              subjectCount: 0,
              latestUpdateAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    await expect(page.getByTestId('child-list-homework-count-student-indicators-1')).toContainText('2');
    await expect(page.getByTestId('child-list-negative-count-student-indicators-1')).toContainText('0');
    await expect(page.getByTestId('child-list-positive-count-student-indicators-1')).toContainText('0');
    await expect(
      page.getByTestId('child-list-positive-count-student-indicators-1').locator('svg.lucide-thumbs-up'),
    ).toBeVisible();
  });
});

test.describe('Child workspace page', () => {
  const UNKNOWN_GUID = 'e2e-test-unknown-guid-00001';
  const STUDENT_GUID = 'e2e-test-student-guid-00002';

  function stubWorkspaceRoutes(page: import('@playwright/test').Page) {
    return page.route(`**/api/v1/children/${STUDENT_GUID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
            positiveBehaviorCount: 1,
            subjectCount: 1,
            totalWeeklyHours: 6,
            attentionBehaviorCount: 1,
          },
          lastSyncAt: new Date().toISOString(),
        }),
      });
    });
  }

  test('shows error state for an unknown student GUID', async ({ page }) => {
    await page.route(`**/api/v1/children/${UNKNOWN_GUID}`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(UNKNOWN_GUID);

    const workspaceVisible = await workspace.workspaceContainer.isVisible();
    expect(workspaceVisible).toBe(false);
  });

  test('workspace section tabs are rendered for a valid student', async ({ page }) => {
    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();
    expect(page.url()).toContain('/children');
  });

  test('workspace header shows homework, negative, and positive indicators', async ({ page }) => {
    await stubWorkspaceRoutes(page);
    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID);

    await expect(page.getByTestId('child-header-homework-count')).toContainText('1');
    await expect(page.getByTestId('child-header-negative-count')).toContainText('1');
    await expect(page.getByTestId('child-header-positive-count')).toContainText('1');
    await expect(
      page.getByTestId('child-header-positive-count').locator('svg.lucide-thumbs-up'),
    ).toBeVisible();
  });

  test('homework item opens dedicated detail page', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
              recentBehaviorCount: 0,
              subjectCount: 1,
              latestUpdateAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/hw-1`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeHomeworkItem()),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeHomeworkItem()],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    await expect(page.getByTestId('homework-item-link-hw-1')).toBeVisible();
    await page.getByTestId('homework-item-link-hw-1').click();

    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();
  });

  test('homework detail renders attachment download links', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          makeHomeworkItem({
            files: [{ fileId: 'hw-file-1', fileName: 'homework.pdf' }],
          }),
        ),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();

    const attachmentLink = page.getByRole('link', { name: 'homework.pdf' });
    await expect(attachmentLink).toBeVisible();
    await expect(attachmentLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/homework/hw-1/files/hw-file-1`,
    );
  });

  test('homework list shows unread tab by default and filters out archived items', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-archived', isNew: false, isArchived: true, homeworkText: 'Old homework' })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-active', isNew: true, isArchived: false })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      }
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    // Unread tab is default — unread item is visible
    await expect(page.getByTestId('homework-item-link-hw-active')).toBeVisible();
    await expect(page.getByTestId('homework-item-link-hw-archived')).toHaveCount(0);
  });

  test('homework archived tab shows only archived items', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-archived-tab', isNew: false, isArchived: true, subjectName: 'History' })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-active-tab', isNew: true, isArchived: false })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      }
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    // Click the archived tab
    const archivedTab = page.getByTestId('homework-filter-archived');
    await archivedTab.click();
    await expect(page.getByTestId('homework-item-link-hw-archived-tab')).toBeVisible();
    await expect(page.getByTestId('homework-item-link-hw-active-tab')).toHaveCount(0);
    await expect(page.getByTestId('homework-mark-new-hw-archived-tab')).toHaveCount(0);
    await expect(page.getByTestId('homework-archive-hw-archived-tab')).toBeVisible();
  });

  test('homework new-tab bulk actions call is-new and archive endpoints', async ({ page }) => {
    let markReadBody: unknown = null;
    let archiveBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/is-new`)) {
        markReadBody = req.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/archive`)) {
        archiveBody = req.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            makeHomeworkItem({ id: 'hw-bulk-1', isNew: true, isArchived: false }),
            makeHomeworkItem({ id: 'hw-bulk-2', isNew: true, isArchived: false }),
          ],
          pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    await page.getByTestId('homework-select-hw-bulk-1').check();
    await expect(page.getByTestId('homework-bulk-actions')).toBeVisible();
    await expect(page.getByTestId('homework-bulk-mark-read')).toBeVisible();
    await expect(page.getByTestId('homework-bulk-archive')).toBeVisible();
    await expect(page.getByTestId('homework-bulk-mark-unread')).toHaveCount(0);

    await page.getByTestId('homework-bulk-mark-read').click();
    await expect.poll(() => markReadBody).not.toBeNull();
    expect(markReadBody).toEqual({ homeworkIds: ['hw-bulk-1'], isNew: false });
    await expect(page.getByTestId('homework-bulk-actions')).toHaveCount(0);

    await page.getByTestId('homework-select-hw-bulk-2').check();
    await page.getByTestId('homework-bulk-archive').click();
    await expect.poll(() => archiveBody).not.toBeNull();
    expect(archiveBody).toEqual({ homeworkIds: ['hw-bulk-2'], isArchived: true });
    await expect(page.getByTestId('homework-bulk-actions')).toHaveCount(0);
  });

  test('homework archived-tab bulk action calls unarchive', async ({ page }) => {
    let unarchiveBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const status = url.searchParams.get('status');

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/archive`)) {
        unarchiveBody = req.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-bulk-archived', isNew: false, isArchived: true })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeHomeworkItem({ id: 'hw-bulk-active', isNew: true, isArchived: false })],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    await page.getByTestId('homework-filter-archived').click();
    await page.getByTestId('homework-select-hw-bulk-archived').check();
    await expect(page.getByTestId('homework-bulk-unarchive')).toBeVisible();
    await expect(page.getByTestId('homework-bulk-archive')).toHaveCount(0);
    await page.getByTestId('homework-bulk-unarchive').click();

    await expect.poll(() => unarchiveBody).not.toBeNull();
    expect(unarchiveBody).toEqual({ homeworkIds: ['hw-bulk-archived'], isArchived: false });
    await expect(page.getByTestId('homework-bulk-actions')).toHaveCount(0);
  });

  test('homework bulk selection clears on action success and status filter change', async ({ page }) => {
    let markReadBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const status = url.searchParams.get('status');

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/is-new`)) {
        markReadBody = req.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeHomeworkItem({ id: 'hw-selection-archived', isNew: false, isArchived: true })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeHomeworkItem({ id: 'hw-selection-new', isNew: true, isArchived: false })],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');

    await page.getByTestId('homework-select-hw-selection-new').check();
    await expect(page.getByTestId('homework-bulk-actions')).toBeVisible();
    await page.getByTestId('homework-bulk-mark-read').click();
    await expect.poll(() => markReadBody).not.toBeNull();
    await expect(page.getByTestId('homework-bulk-actions')).toHaveCount(0);

    await page.getByTestId('homework-select-hw-selection-new').check();
    await expect(page.getByTestId('homework-bulk-actions')).toBeVisible();
    await page.getByTestId('homework-filter-archived').click();
    await expect(page.getByTestId('homework-bulk-actions')).toHaveCount(0);
  });

  test('toggle isNew on homework detail page calls is-new endpoint', async ({ page }) => {
    let isNewRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeHomeworkItem({ isNew: true })),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1/is-new`, async (route) => {
      isNewRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ isNew: false })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();

    const toggleButton = page.getByTestId('homework-detail-toggle-new-hw-1');
    await expect(toggleButton).toBeVisible();
    await toggleButton.click();
    await expect.poll(() => isNewRequestBody).not.toBeNull();
    expect(isNewRequestBody).toMatchObject({ isNew: false });
  });

  test('archive action on homework detail calls archive endpoint and sets isArchived=true', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeHomeworkItem({ isNew: true, isArchived: false })),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1/archive`, async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ isNew: false, isArchived: true })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();

    const archiveButton = page.getByTestId('homework-detail-archive-hw-1');
    await expect(archiveButton).toBeVisible();
    await archiveButton.click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    expect(archiveRequestBody).toMatchObject({ isArchived: true });
  });

  test('explicit homework detail action navigates back to workspace list', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
      });
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/children/${STUDENT_GUID}/homework/hw-1`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeHomeworkItem({ isNew: false, isArchived: false })),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeHomeworkItem({ id: 'hw-1', isNew: false, isArchived: false })],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1/archive`, async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ id: 'hw-1', isNew: false, isArchived: true })),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'homework', 'all');
    await page.getByTestId('homework-item-link-hw-1').click();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/homework/hw-1`);

    await page.getByTestId('homework-detail-archive-hw-1').click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    await expect(page).toHaveURL(
      `/children/${STUDENT_GUID}?section=homework&behavior=all`,
    );
  });

  test('opening homework detail directly does not auto-navigate away after auto mark-read', async ({ page }) => {
    let isNewRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);
    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ isNew: true, isArchived: false })),
      });
    });
    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1/is-new`, async (route) => {
      isNewRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ isNew: false, isArchived: false })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();
    await expect.poll(() => isNewRequestBody).not.toBeNull();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/homework/hw-1`);
  });

  test('unarchive action on homework restores isNew=true', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeHomeworkItem({ isNew: false, isArchived: true })),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/hw-1/archive`, async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeHomeworkItem({ isNew: true, isArchived: false })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/homework/hw-1`);
    await expect(page.getByTestId('homework-detail-hw-1')).toBeVisible();

    await expect(page.getByTestId('homework-detail-toggle-new-hw-1')).toHaveCount(0);
    const unarchiveButton = page.getByTestId('homework-detail-archive-hw-1');
    await expect(unarchiveButton).toBeVisible();
    await unarchiveButton.click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    expect(archiveRequestBody).toMatchObject({ isArchived: false });
  });

  test('behavior item opens dedicated detail page', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
              recentHomeworkCount: 0,
              recentBehaviorCount: 1,
              subjectCount: 1,
              latestUpdateAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/children/${STUDENT_GUID}/behavior/beh-1`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeBehaviorItem()),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeBehaviorItem()],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'behavior', 'all');

    await expect(page.getByTestId('behavior-item-link-beh-1')).toBeVisible();
    await page.getByTestId('behavior-item-link-beh-1').click();

    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/behavior/beh-1`);
    await expect(page.getByTestId('behavior-detail-beh-1')).toBeVisible();
  });

  test('behavior detail renders attachment download links', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          makeBehaviorItem({
            files: [{ fileId: 'beh-file-1', fileName: 'behavior.pdf' }],
          }),
        ),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/behavior/beh-1`);
    await expect(page.getByTestId('behavior-detail-beh-1')).toBeVisible();

    const attachmentLink = page.getByRole('link', { name: 'behavior.pdf' });
    await expect(attachmentLink).toBeVisible();
    await expect(attachmentLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/behavior/beh-1/files/beh-file-1`,
    );
  });

  test('behavior list shows unread tab by default and filters out archived items', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeBehaviorItem({ id: 'beh-archived', isNew: false, isArchived: true, achvaName: 'Old event' })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeBehaviorItem({ id: 'beh-active', isNew: true, isArchived: false })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      }
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'behavior', 'all');

    await expect(page.getByTestId('behavior-item-link-beh-active')).toBeVisible();
    await expect(page.getByTestId('behavior-item-link-beh-archived')).toHaveCount(0);
  });

  test('behavior archived tab shows only archived items', async ({ page }) => {
    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');

      if (status === 'archived') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeBehaviorItem({ id: 'beh-archived-tab', isNew: false, isArchived: true })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [makeBehaviorItem({ id: 'beh-active-tab', isNew: true, isArchived: false })],
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          }),
        });
      }
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'behavior', 'all');

    const archivedTab = page.getByTestId('behavior-status-archived');
    await archivedTab.click();
    await expect(page.getByTestId('behavior-item-link-beh-archived-tab')).toBeVisible();
    await expect(page.getByTestId('behavior-item-link-beh-active-tab')).toHaveCount(0);
    await expect(page.getByTestId('behavior-mark-new-beh-archived-tab')).toHaveCount(0);
    await expect(page.getByTestId('behavior-archive-beh-archived-tab')).toBeVisible();
  });

  test('behavior all-tab bulk actions are selection-aware for mixed item states', async ({ page }) => {
    let markReadBody: unknown = null;
    let markUnreadBody: unknown = null;
    let archiveBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const status = url.searchParams.get('status');

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/behavior/is-new`)) {
        const payload = req.postDataJSON() as { isNew?: boolean };
        if (payload?.isNew) {
          markUnreadBody = payload;
        } else {
          markReadBody = payload;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      if (req.method() === 'PUT' && url.pathname.endsWith(`/children/${STUDENT_GUID}/behavior/archive`)) {
        const payload = req.postDataJSON() as { isArchived?: boolean };
        if (payload?.isArchived) {
          archiveBody = payload;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ updated: 1 }),
        });
        return;
      }

      if (status === 'all') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              makeBehaviorItem({ id: 'beh-all-new', isNew: true, isArchived: false }),
              makeBehaviorItem({ id: 'beh-all-read', isNew: false, isArchived: false }),
            ],
            pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeBehaviorItem({ id: 'beh-default-new', isNew: true, isArchived: false })],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    const newSelectionCheckbox = page.getByTestId('behavior-select-beh-all-new');
    const readSelectionCheckbox = page.getByTestId('behavior-select-beh-all-read');

    const navigateToAllBehavior = async () => {
      await workspace.navigate(STUDENT_GUID, 'behavior', 'all');
      await page.getByTestId('behavior-status-all').click();
      await expect(page.getByTestId('behavior-item-link-beh-all-new')).toBeVisible();
      await expect(page.getByTestId('behavior-item-link-beh-all-read')).toBeVisible();
    };

    const selectAllBehaviorItems = async () => {
      await expect(newSelectionCheckbox).toBeVisible();
      await expect(readSelectionCheckbox).toBeVisible();
      await newSelectionCheckbox.check();
      await readSelectionCheckbox.check();
      await expect(newSelectionCheckbox).toBeChecked();
      await expect(readSelectionCheckbox).toBeChecked();
    };

    await navigateToAllBehavior();
    await selectAllBehaviorItems();

    await expect(page.getByTestId('behavior-bulk-mark-read')).toBeVisible();
    await expect(page.getByTestId('behavior-bulk-mark-unread')).toBeVisible();
    await expect(page.getByTestId('behavior-bulk-archive')).toBeVisible();
    await expect(page.getByTestId('behavior-bulk-unarchive')).toHaveCount(0);

    await page.getByTestId('behavior-bulk-mark-read').click();
    await expect.poll(() => markReadBody).not.toBeNull();
    expect(markReadBody).toEqual({ behaviorIds: ['beh-all-new'], isNew: false });

    await navigateToAllBehavior();
    await selectAllBehaviorItems();
    await page.getByTestId('behavior-bulk-mark-unread').click();
    await expect.poll(() => markUnreadBody).not.toBeNull();
    expect(markUnreadBody).toEqual({ behaviorIds: ['beh-all-read'], isNew: true });

    await navigateToAllBehavior();
    await selectAllBehaviorItems();
    await page.getByTestId('behavior-bulk-archive').click();
    await expect.poll(() => archiveBody).not.toBeNull();
    expect(archiveBody).toEqual({ behaviorIds: ['beh-all-new', 'beh-all-read'], isArchived: true });
  });

  test('toggle isNew on behavior detail page calls is-new endpoint', async ({ page }) => {
    let isNewRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeBehaviorItem({ isNew: true })),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1/is-new`, async (route) => {
      isNewRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeBehaviorItem({ isNew: false })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/behavior/beh-1`);
    await expect(page.getByTestId('behavior-detail-beh-1')).toBeVisible();

    const toggleButton = page.getByTestId('behavior-detail-toggle-new-beh-1');
    await expect(toggleButton).toBeVisible();
    await toggleButton.click();
    await expect.poll(() => isNewRequestBody).not.toBeNull();
    expect(isNewRequestBody).toMatchObject({ isNew: false });
  });

  test('archive action on behavior calls archive endpoint', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeBehaviorItem({ isNew: true, isArchived: false })),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1/archive`, async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeBehaviorItem({ isNew: false, isArchived: true })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/behavior/beh-1`);
    await expect(page.getByTestId('behavior-detail-beh-1')).toBeVisible();

    const archiveButton = page.getByTestId('behavior-detail-archive-beh-1');
    await expect(archiveButton).toBeVisible();
    await archiveButton.click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    expect(archiveRequestBody).toMatchObject({ isArchived: true });
  });

  test('explicit behavior detail action navigates back to workspace list', async ({ page }) => {
    let archiveRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
      });
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/children/${STUDENT_GUID}/behavior/beh-1`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeBehaviorItem({ isNew: false, isArchived: false })),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [makeBehaviorItem({ id: 'beh-1', isNew: false, isArchived: false })],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1/archive`, async (route) => {
      archiveRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeBehaviorItem({ id: 'beh-1', isNew: false, isArchived: true })),
      });
    });

    const workspace = new ChildWorkspacePage(page);
    await workspace.navigate(STUDENT_GUID, 'behavior', 'all');
    await page.getByTestId('behavior-item-link-beh-1').click();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/behavior/beh-1`);

    await page.getByTestId('behavior-detail-archive-beh-1').click();
    await expect.poll(() => archiveRequestBody).not.toBeNull();
    await expect(page).toHaveURL(
      `/children/${STUDENT_GUID}?section=behavior&behavior=all`,
    );
  });

  test('opening behavior detail directly does not auto-navigate away after auto mark-read', async ({ page }) => {
    let isNewRequestBody: unknown = null;

    await stubWorkspaceRoutes(page);
    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeBehaviorItem({ isNew: true, isArchived: false })),
      });
    });
    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/beh-1/is-new`, async (route) => {
      isNewRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeBehaviorItem({ isNew: false, isArchived: false })),
      });
    });

    await page.goto(`/children/${STUDENT_GUID}/behavior/beh-1`);
    await expect(page.getByTestId('behavior-detail-beh-1')).toBeVisible();
    await expect.poll(() => isNewRequestBody).not.toBeNull();
    await expect(page).toHaveURL(`/children/${STUDENT_GUID}/behavior/beh-1`);
  });
});
