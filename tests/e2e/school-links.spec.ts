import { test, expect, type Page } from '@playwright/test';
import { MorePage } from './pages/MorePage';

/**
 * Managing the household's schools.
 *
 * The unlink cases are the ones that matter most: before this work the delete
 * was global -- `mailConversation.deleteMany({})` with no `where` at all -- so
 * unlinking one school took the other school's mail with it, and the parent
 * was signed out of a household they still had.
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

function link(school: typeof SCHOOL_A, overrides: Record<string, unknown> = {}) {
  return {
    ...school,
    username: 'parent',
    childrenCount: 1,
    isPrimary: school.id === SCHOOL_A.id,
    lastLoginAt: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

async function seed(
  page: Page,
  options: {
    schools: Array<typeof SCHOOL_A>;
    links: Array<Record<string, unknown>>;
    onCreate?: (route: Parameters<Parameters<Page['route']>[1]>[0]) => Promise<void>;
    onDelete?: (route: Parameters<Parameters<Page['route']>[1]>[0]) => Promise<void>;
  },
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

  // Order matters: the specific routes are registered first, because
  // Playwright matches the most recently registered route and both patterns
  // overlap on the collection URL.
  await page.route('**/api/v1/school-links/*', async (route) => {
    if (route.request().method() === 'DELETE' && options.onDelete) {
      await options.onDelete(route);
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v1/school-links', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      if (options.onCreate) {
        await options.onCreate(route);
        return;
      }
      await route.fulfill({ status: 201, json: link(SCHOOL_B) });
      return;
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({
      json: {
        data: options.links,
        pagination: {
          page: 1,
          limit: Math.max(options.links.length, 1),
          total: options.links.length,
          totalPages: options.links.length === 0 ? 0 : 1,
        },
      },
    });
  });

  await page.route('**/api/v1/settings/source-health', (route) =>
    route.fulfill({ json: { sources: [], overallState: 'fresh', lastFullSyncAt: null } }),
  );
  await page.route('**/api/v1/settings/profile', (route) =>
    route.fulfill({
      json: {
        upstreamUserId: 'e2e-parent-1',
        displayName: 'E2E Parent',
        email: '',
        cellphone: '',
        schoolName: SCHOOL_A.schoolName,
        schoolYear: 2026,
        schoolCode: SCHOOL_A.semel,
        detailsState: 1,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route('**/api/v1/children', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/v1/mail/summary', (route) =>
    route.fulfill({ json: { newConversations: 0, recentConversations: [], lastSyncAt: null } }),
  );
}

test.describe('School links — listing', () => {
  test('lists both connected schools with their child counts', async ({ page }) => {
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A, { childrenCount: 2 }), link(SCHOOL_B, { childrenCount: 1 })],
    });
    const more = new MorePage(page);

    await more.navigate();

    await expect(more.schoolsCard).toBeVisible();
    await expect(more.schoolName(SCHOOL_A.semel)).toHaveText(SCHOOL_A.schoolName);
    await expect(more.schoolName(SCHOOL_B.semel)).toHaveText(SCHOOL_B.schoolName);
    await expect(more.schoolChildrenCount(SCHOOL_A.semel)).toHaveText('2 ילדים');
    await expect(more.schoolChildrenCount(SCHOOL_B.semel)).toHaveText('1 ילד');
  });

  test('says a school is still syncing until its first run succeeds', async ({ page }) => {
    // A failed run must not read as a finished sync, so the server sends null
    // until one has actually succeeded.
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A), link(SCHOOL_B, { lastSyncAt: null })],
    });
    const more = new MorePage(page);

    await more.navigate();

    await expect(more.schoolSyncing(SCHOOL_B.semel)).toBeVisible();
    await expect(more.schoolSyncing(SCHOOL_A.semel)).toHaveCount(0);
  });

  test('offers an add-school row', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    const more = new MorePage(page);

    await more.navigate();

    await expect(more.addSchoolButton).toBeVisible();
  });

  test('the bulk disconnect names every school when there are several', async ({ page }) => {
    // "ניתוק מבית הספר" is a lie with two schools connected.
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A), link(SCHOOL_B)],
    });
    const more = new MorePage(page);

    await more.navigate();

    await expect(more.bulkDisconnectButton).toHaveText('ניתוק מכל בתי הספר');
  });

  test('the bulk disconnect stays singular with one school', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    const more = new MorePage(page);

    await more.navigate();

    await expect(more.bulkDisconnectButton).toHaveText('ניתוק מבית הספר');
  });
});

test.describe('School links — unlinking', () => {
  test('names the blast radius and the school that survives', async ({ page }) => {
    // The old copy said "כל המידע יימחק", which with two schools is simply
    // untrue. A parent cannot consent to something described wrongly.
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A, { childrenCount: 2 }), link(SCHOOL_B)],
    });
    const more = new MorePage(page);
    await more.navigate();

    await more.unlinkButton(SCHOOL_A.semel).click();

    await expect(more.unlinkModal).toBeVisible();
    await expect(more.unlinkModal).toContainText(`לנתק את "${SCHOOL_A.schoolName}"?`);
    await expect(more.unlinkModal).toContainText('2 הילדים');
    await expect(more.unlinkModal).toContainText(
      `הנתונים של "${SCHOOL_B.schoolName}" יישארו`,
    );
  });

  test('unlinking one school keeps the parent signed in', async ({ page }) => {
    // The decisive case. Never sign a parent out of a household they still
    // have: one of two schools going away is not the end of their account.
    let deleted: string | null = null;
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A), link(SCHOOL_B)],
      onDelete: async (route) => {
        deleted = new URL(route.request().url()).pathname.split('/').pop() ?? null;
        await route.fulfill({ status: 204, body: '' });
      },
    });
    const more = new MorePage(page);
    await more.navigate();

    await more.unlinkSchool(SCHOOL_A.semel);

    await expect(more.unlinkModal).toHaveCount(0);
    expect(deleted).toBe(SCHOOL_A.id);
    // Still on /more, not thrown at sign-in.
    await expect(more.morePageContainer).toBeVisible();
    expect(page.url()).toContain('/more');
  });

  test('unlinking the only school warns that it signs you out', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    const more = new MorePage(page);
    await more.navigate();

    await more.unlinkButton(SCHOOL_A.semel).click();

    // Routed to the bulk confirm, which is the one that tells the truth about
    // what unlinking the last school does.
    await expect(page.getByText('זה בית הספר היחיד המחובר')).toBeVisible();
  });

  test('unlinking every school returns to sign-in', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    const more = new MorePage(page);
    await more.navigate();

    await more.bulkDisconnectButton.click();
    await page.getByTestId('settings-disconnect-confirm-btn').click();

    await page.waitForURL('**/auth/sign-in');
    expect(page.url()).toContain('/auth/sign-in');
  });
});

test.describe('School links — adding', () => {
  test('a disabled option marks a school that is already linked', async ({ page }) => {
    // Preventing the error beats reporting it, and a parent looking for a
    // school they already added needs to see that it is there.
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    await page.route('**/api/v1/schools', (route) =>
      route.fulfill({
        json: [
          { semel: SCHOOL_A.semel, name: SCHOOL_A.schoolName, years: [2026] },
          { semel: SCHOOL_B.semel, name: SCHOOL_B.schoolName, years: [2026] },
        ],
      }),
    );

    await page.goto('/more/schools/new');
    await expect(page.getByTestId('add-school-page')).toBeVisible();
    await page.getByTestId('add-school-selector').click();

    await expect(page.getByTestId(`school-option-${SCHOOL_A.semel}`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByTestId(`school-option-${SCHOOL_B.semel}`)).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test.describe('reports each failure in the parent\'s own words', () => {
    const CASES: Array<{ code: string; status: number; hebrew: string }> = [
      {
        code: 'INVALID_CREDENTIALS',
        status: 401,
        hebrew: 'שם המשתמש או הסיסמה שגויים עבור בית הספר הזה',
      },
      {
        code: 'UPSTREAM_ERROR',
        status: 502,
        hebrew: 'לא הצלחנו להתחבר למשוב כרגע. נסו שוב בעוד כמה דקות',
      },
      {
        code: 'SCHOOL_ALREADY_LINKED',
        status: 409,
        hebrew: 'בית הספר הזה כבר מחובר לחשבון',
      },
      { code: 'CONNECTION_ALREADY_LINKED', status: 409, hebrew: 'החשבון הזה כבר מחובר' },
      {
        code: 'NO_CHILDREN_FOUND',
        status: 422,
        hebrew:
          'לא נמצאו ילדים בחשבון הזה. בדקו שהזנתם את פרטי ההורה במשוב, ולא את פרטי התלמיד',
      },
      {
        code: 'NO_ACTIVE_CHILDREN',
        status: 422,
        hebrew: 'כל הילדים בחשבון הזה אינם פעילים בבית הספר',
      },
      { code: 'LIMIT_REACHED', status: 409, hebrew: 'ניתן לחבר עד 4 בתי ספר' },
      { code: 'RATE_LIMITED', status: 429, hebrew: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה' },
      { code: 'SOMETHING_NEW', status: 500, hebrew: 'אירעה שגיאה, נסו שוב מאוחר יותר' },
    ];

    for (const { code, status, hebrew } of CASES) {
      test(`${code} reads "${hebrew}"`, async ({ page }) => {
        await seed(page, {
          schools: [SCHOOL_A],
          links: [link(SCHOOL_A)],
          onCreate: async (route) => {
            await route.fulfill({
              status,
              json: { error: { code, message: code, details: [] } },
            });
          },
        });
        await page.route('**/api/v1/schools', (route) =>
          route.fulfill({
            json: [{ semel: SCHOOL_B.semel, name: SCHOOL_B.schoolName, years: [2026] }],
          }),
        );

        await page.goto('/more/schools/new');
        await page.getByTestId('add-school-selector').click();
        await page.getByTestId(`school-option-${SCHOOL_B.semel}`).click();
        await page.getByTestId('add-school-username').fill('parent-b');
        await page.getByTestId('add-school-password').fill('pw');
        await page.getByTestId('add-school-submit-btn').click();

        await expect(page.getByTestId('add-school-error')).toHaveText(hebrew);
        // A credential rejection must NOT be mistaken for an expired session:
        // the parent stays on the form rather than being thrown at sign-in.
        expect(page.url()).toContain('/more/schools/new');
      });
    }
  });

  test('a successful link goes to the syncing screen for that school', async ({ page }) => {
    await seed(page, {
      schools: [SCHOOL_A],
      links: [link(SCHOOL_A)],
      onCreate: async (route) => {
        await route.fulfill({ status: 201, json: link(SCHOOL_B, { lastSyncAt: null }) });
      },
    });
    await page.route('**/api/v1/schools', (route) =>
      route.fulfill({
        json: [{ semel: SCHOOL_B.semel, name: SCHOOL_B.schoolName, years: [2026] }],
      }),
    );
    await page.route('**/api/v1/sync/status*', (route) =>
      route.fulfill({
        json: {
          done: false,
          sourcesCompleted: 1,
          sourcesTotal: 17,
          phase: 'running',
          refreshId: 'r1',
          startedAt: new Date().toISOString(),
          endedAt: null,
          tasksTotal: 17,
          tasksSettled: 1,
          tasksFailed: 0,
          currentTask: 'homework',
          tasks: [],
          schools: [],
        },
      }),
    );
    await page.route('**/api/v1/sync/refresh*', (route) =>
      route.fulfill({ json: { status: 'success', tasks: [] } }),
    );

    await page.goto('/more/schools/new');
    await page.getByTestId('add-school-selector').click();
    await page.getByTestId(`school-option-${SCHOOL_B.semel}`).click();
    await page.getByTestId('add-school-username').fill('parent-b');
    await page.getByTestId('add-school-password').fill('pw');
    await page.getByTestId('add-school-submit-btn').click();

    await page.waitForURL(`**/auth/syncing?schoolId=${SCHOOL_B.id}`);
    // Its own headline: the parent is linking a school, not setting up an
    // account.
    await expect(page.getByTestId('syncing-heading')).toHaveText('מחברים את בית הספר…');
  });
});
