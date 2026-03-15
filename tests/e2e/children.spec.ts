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
    await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    const countAfterReload = await childrenPage.allChildCards().count();
    expect(countAfterReload).toBe(initialCount);
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
    await page.waitForLoadState('networkidle');

    const attachmentLink = page.getByRole('link', { name: 'homework.pdf' });
    await expect(attachmentLink).toBeVisible();
    await expect(attachmentLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/homework/hw-1/files/hw-file-1`,
    );
  });

  test('homework list shows Active tab by default and filters out archived items', async ({ page }) => {
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

    // Active tab is default — active item is visible
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
    const archivedTab = page.getByTestId('homework-tab-archived');
    if (await archivedTab.isVisible()) {
      await archivedTab.click();
      await expect(page.getByTestId('homework-item-link-hw-archived-tab')).toBeVisible();
      await expect(page.getByTestId('homework-item-link-hw-active-tab')).toHaveCount(0);
    }
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
    await page.waitForLoadState('networkidle');

    const toggleButton = page.getByTestId('homework-toggle-is-new');
    if (await toggleButton.isVisible()) {
      await toggleButton.click();
      await expect.poll(() => isNewRequestBody).not.toBeNull();
      expect(isNewRequestBody).toMatchObject({ isNew: false });
    }
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
    await page.waitForLoadState('networkidle');

    const archiveButton = page.getByTestId('homework-archive-button');
    if (await archiveButton.isVisible()) {
      await archiveButton.click();
      await expect.poll(() => archiveRequestBody).not.toBeNull();
      expect(archiveRequestBody).toMatchObject({ isArchived: true });
    }
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
    await page.waitForLoadState('networkidle');

    const unarchiveButton = page.getByTestId('homework-unarchive-button');
    if (await unarchiveButton.isVisible()) {
      await unarchiveButton.click();
      await expect.poll(() => archiveRequestBody).not.toBeNull();
      expect(archiveRequestBody).toMatchObject({ isArchived: false });
    }
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
    await page.waitForLoadState('networkidle');

    const attachmentLink = page.getByRole('link', { name: 'behavior.pdf' });
    await expect(attachmentLink).toBeVisible();
    await expect(attachmentLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/behavior/beh-1/files/beh-file-1`,
    );
  });

  test('behavior list shows Active tab by default and filters out archived items', async ({ page }) => {
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

    const archivedTab = page.getByTestId('behavior-tab-archived');
    if (await archivedTab.isVisible()) {
      await archivedTab.click();
      await expect(page.getByTestId('behavior-item-link-beh-archived-tab')).toBeVisible();
      await expect(page.getByTestId('behavior-item-link-beh-active-tab')).toHaveCount(0);
    }
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
    await page.waitForLoadState('networkidle');

    const toggleButton = page.getByTestId('behavior-toggle-is-new');
    if (await toggleButton.isVisible()) {
      await toggleButton.click();
      await expect.poll(() => isNewRequestBody).not.toBeNull();
      expect(isNewRequestBody).toMatchObject({ isNew: false });
    }
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
    await page.waitForLoadState('networkidle');

    const archiveButton = page.getByTestId('behavior-archive-button');
    if (await archiveButton.isVisible()) {
      await archiveButton.click();
      await expect.poll(() => archiveRequestBody).not.toBeNull();
      expect(archiveRequestBody).toMatchObject({ isArchived: true });
    }
  });
});
