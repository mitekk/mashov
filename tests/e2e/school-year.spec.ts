import { test, expect } from '@playwright/test';
import { ChildrenPage } from './pages/ChildrenPage';

/**
 * The user-visible symptom of the frozen school year was a child card still
 * showing last year's class. `classCode`/`classNum` are only ever written by a
 * roster refresh, so this is the one screen that proves the roster advanced.
 */

const STUDENT_GUID = 'e2e-test-student-guid-00002';

function makeChild(overrides: object = {}) {
  return {
    studentGuid: STUDENT_GUID,
    privateName: 'Avi',
    familyName: 'Cohen',
    fullName: 'Avi Cohen',
    classCode: 'ו',
    classNum: 2,
    gender: 'M',
    isActive: true,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    subjectCount: 0,
    latestUpdateAt: null,
    ...overrides,
  };
}

test.describe('Children page — school year advance', () => {
  test('shows the updated class on the child card after the year advances', async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [makeChild({ classCode: 'ז', classNum: 3 })] }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    await expect(childrenPage.childClass(STUDENT_GUID)).toContainText('ז3');
  });

  test("shows last year's class until the roster refreshes", async ({ page }) => {
    await page.route('**/api/v1/children', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [makeChild()] }),
      });
    });

    const childrenPage = new ChildrenPage(page);
    await childrenPage.navigate();

    await expect(childrenPage.childClass(STUDENT_GUID)).toContainText('ו2');
    await expect(childrenPage.childClass(STUDENT_GUID)).not.toContainText('ז3');
  });
});
