import { test, expect, type Page } from '@playwright/test';
import { ChildrenPage } from './pages/ChildrenPage';

/**
 * The school filter, and the rule that makes the whole feature safe to ship:
 * every school-aware surface renders nothing below two connected schools, so a
 * one-school household's DOM is unchanged.
 *
 * The filter lives in `?school=`, not in state or localStorage. A persisted
 * filter that silently hides one of a parent's children is the worst failure
 * this feature can have; a URL resets on a fresh visit, survives the back
 * button, and is visible in a support screenshot.
 */

const SCHOOL_A = {
  id: 'conn-a',
  semel: 540175,
  schoolName: 'אורט רמון',
  shortLabel: 'אורט רמון',
  schoolYear: 2026,
};
const SCHOOL_B = {
  id: 'conn-b',
  semel: 999999,
  schoolName: 'תיכון רמון',
  shortLabel: 'תיכון רמון',
  schoolYear: 2026,
};

function child(overrides: Record<string, unknown>) {
  return {
    studentGuid: 'guid-x',
    privateName: 'ילד',
    familyName: 'כלשהו',
    fullName: 'ילד כלשהו',
    classCode: 'ז',
    classNum: 1,
    gender: 'M',
    isActive: true,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    subjectCount: 0,
    latestUpdateAt: null,
    schoolId: null,
    schoolName: null,
    schoolShortLabel: null,
    semel: null,
    ...overrides,
  };
}

const CHILD_A = child({
  studentGuid: 'guid-a',
  fullName: 'מיקה קורס',
  schoolId: SCHOOL_A.id,
  schoolName: SCHOOL_A.schoolName,
  schoolShortLabel: SCHOOL_A.shortLabel,
  semel: SCHOOL_A.semel,
});
const CHILD_B = child({
  studentGuid: 'guid-b',
  fullName: 'נועה קורס',
  schoolId: SCHOOL_B.id,
  schoolName: SCHOOL_B.schoolName,
  schoolShortLabel: SCHOOL_B.shortLabel,
  semel: SCHOOL_B.semel,
});

async function seed(
  page: Page,
  options: { schools: typeof SCHOOL_A[]; children: Array<Record<string, unknown>> },
): Promise<void> {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        mashovUserId: 'e2e-parent-1',
        username: 'e2e-parent',
        displayName: 'E2E Parent',
        connectedSchool: {
          schoolName: options.schools[0]?.schoolName ?? '',
          schoolYear: options.schools[0]?.schoolYear ?? 2026,
        },
        schools: options.schools,
      },
    }),
  );
  await page.route('**/api/v1/children', (route) =>
    route.fulfill({ json: { data: options.children } }),
  );
  await page.route('**/api/v1/mail/summary', (route) =>
    route.fulfill({ json: { newConversations: 0, recentConversations: [], lastSyncAt: null } }),
  );
  await page.route('**/api/v1/settings/source-health', (route) =>
    route.fulfill({ json: { sources: [], overallState: 'fresh', lastFullSyncAt: null } }),
  );
}

test.describe('School filter', () => {
  test('is absent entirely with one connected school', async ({ page }) => {
    // The no-regression rule. One school means the chip row does not exist --
    // not that it exists with a single option.
    await seed(page, { schools: [SCHOOL_A], children: [CHILD_A] });
    const children = new ChildrenPage(page);

    await children.navigate();

    await expect(children.schoolFilterChips).toHaveCount(0);
    await expect(children.schoolBadge('guid-a')).toHaveCount(0);
  });

  test('appears with two connected schools', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);

    await children.navigate();

    await expect(children.schoolFilterChips).toBeVisible();
    await expect(children.schoolFilterChip('all')).toBeVisible();
    await expect(children.schoolFilterChip(SCHOOL_A.semel)).toBeVisible();
    await expect(children.schoolFilterChip(SCHOOL_B.semel)).toBeVisible();
  });

  test('labels each child with its own school', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);

    await children.navigate();

    await expect(children.schoolBadge('guid-a')).toHaveText(SCHOOL_A.shortLabel);
    await expect(children.schoolBadge('guid-b')).toHaveText(SCHOOL_B.shortLabel);
  });

  test('pressing a chip writes ?school= and narrows the list', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);
    await children.navigate();

    await children.filterBySchool(SCHOOL_B.semel);

    expect(page.url()).toContain(`school=${SCHOOL_B.semel}`);
    await expect(children.childCard('guid-b')).toBeVisible();
    await expect(children.childCard('guid-a')).toHaveCount(0);
  });

  test('a deep link applies the filter on first paint', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);

    await page.goto(`/children?school=${SCHOOL_A.semel}`);
    await expect(children.childCard('guid-a')).toBeVisible();

    await expect(children.childCard('guid-b')).toHaveCount(0);
    await expect(children.schoolFilterChip(SCHOOL_A.semel)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('an unknown ?school= shows everything rather than nothing', async ({ page }) => {
    // The decisive safety case. A school since unlinked, a hand-edited URL or
    // a stale bookmark must not produce an empty app.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);

    await page.goto('/children?school=zzz');

    await expect(children.childCard('guid-a')).toBeVisible();
    await expect(children.childCard('guid-b')).toBeVisible();
    await expect(children.schoolFilterChip('all')).toHaveAttribute('aria-pressed', 'true');
  });

  test('going back to all schools clears the param', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    const children = new ChildrenPage(page);
    await page.goto(`/children?school=${SCHOOL_A.semel}`);
    await expect(children.childCard('guid-a')).toBeVisible();

    await children.filterBySchool('all');

    expect(page.url()).not.toContain('school=');
    await expect(children.childCard('guid-b')).toBeVisible();
  });

  test('a school with no children gets its own empty state and a working reset', async ({
    page,
  }) => {
    // Told the generic "no children" message, a parent concludes the school is
    // broken rather than that they are looking through a filter.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A] });
    const children = new ChildrenPage(page);

    await page.goto(`/children?school=${SCHOOL_B.semel}`);
    await expect(page.getByText('אין ילדים בבית הספר הזה')).toBeVisible();

    await page.getByTestId('school-filter-reset-btn').click();

    await expect(children.childCard('guid-a')).toBeVisible();
    expect(page.url()).not.toContain('school=');
  });

  test('an unstamped child stays visible under every filter', async ({ page }) => {
    // NULL means "ownership unknown, re-stamp on the next roster refresh", not
    // "nobody's". Hiding such a child under a chip it can never match would
    // make them unreachable.
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      children: [CHILD_A, child({ studentGuid: 'guid-null', fullName: 'לא מסומן' })],
    });
    const children = new ChildrenPage(page);

    await page.goto(`/children?school=${SCHOOL_B.semel}`);

    await expect(children.childCard('guid-null')).toBeVisible();
  });
});
