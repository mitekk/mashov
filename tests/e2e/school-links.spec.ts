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
  // Registered FIRST, so every specific route below takes precedence.
  //
  // Any endpoint this spec does not anticipate would otherwise reach the real
  // backend, answer 401, and send apiFetch's global handler to /auth/sign-in --
  // which looks exactly like a missing chip. These specs are about the school
  // surfaces, not about which other queries the app shell happens to issue, so
  // an unmatched call gets a benign empty payload rather than an eviction.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      json: { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    }),
  );

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

  // The app shell fetches the dashboard on EVERY page, so this is not optional
  // even on /children: a wrong-shaped payload here takes the whole layout
  // down, heading and all.
  await page.route('**/api/v1/dashboard', (route) =>
    route.fulfill({
      json: {
        freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
        summary: {
          newConversations: 0,
          recentHomeworkCount: 0,
          recentBehaviorCount: 0,
          childrenCount: 0,
        },
        feed: [],
        children: [],
        school: { schoolName: '', schoolYear: 2026 },
      },
    }),
  );

  await page.route('**/api/v1/settings/source-health', (route) =>
    route.fulfill({ json: { sources: [], overallState: 'fresh', lastFullSyncAt: null } }),
  );
  await page.route('**/api/v1/settings/profile', (route) =>
    route.fulfill({
      json: [
        {
          householdConnectionId: 'conn-a',
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
      ],
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

  test('the bulk disconnect with two schools says both are going', async ({ page }) => {
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A), link(SCHOOL_B)],
    });
    const more = new MorePage(page);
    await more.navigate();

    await more.bulkDisconnectButton.click();

    await expect(page.getByText('יימחקו כל הנתונים של כל בתי הספר')).toBeVisible();
    await expect(page.getByText('זה בית הספר היחיד המחובר')).toHaveCount(0);
  });

  test('the bulk disconnect never understates itself before the count is known', async ({
    page,
  }) => {
    // `schoolCount = schoolLinks?.length ?? 1` told a household it was
    // disconnecting its only school whenever the modal opened before
    // ['school-links'] resolved -- while `deleteAllSchoolLinks` wipes every
    // school either way.
    await seed(page, {
      schools: [SCHOOL_A, SCHOOL_B],
      links: [link(SCHOOL_A), link(SCHOOL_B)],
    });
    // Held open and never fulfilled, which makes the unresolved cache a
    // certainty rather than a race: this is the state the old default got
    // wrong, and the only one that can distinguish the two branches.
    await page.route('**/api/v1/school-links', async (route) => {
      if (route.request().method() === 'GET') return;
      await route.fallback();
    });
    const more = new MorePage(page);
    await more.navigate();

    await expect(more.bulkDisconnectButton).toHaveText('ניתוק מכל בתי הספר');
    await more.bulkDisconnectButton.click();

    await expect(page.locator('#disconnect-modal-title')).toHaveText('ניתוק מכל בתי הספר');
    await expect(page.getByText('יימחקו כל הנתונים של כל בתי הספר')).toBeVisible();
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
    await page.route('**/api/v1/auth/schools', (route) =>
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
        await page.route('**/api/v1/auth/schools', (route) =>
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

  test('a school edited out of the input cannot be submitted', async ({ page }) => {
    // Typing over the picked school used to leave the selection in place, so
    // the form submitted a school the input was no longer showing -- and the
    // failure came back naming a school the parent never chose.
    await seed(page, { schools: [SCHOOL_A], links: [link(SCHOOL_A)] });
    await page.route('**/api/v1/auth/schools', (route) =>
      route.fulfill({
        json: [{ semel: SCHOOL_B.semel, name: SCHOOL_B.schoolName, years: [2026] }],
      }),
    );

    await page.goto('/more/schools/new');
    await page.getByTestId('add-school-selector').click();
    await page.getByTestId(`school-option-${SCHOOL_B.semel}`).click();
    await expect(page.getByTestId('add-school-submit-btn')).toBeEnabled();

    await page.getByTestId('add-school-selector').fill('תיכון ר');

    await expect(page.getByTestId('add-school-submit-btn')).toBeDisabled();
  });

  test('a successful link goes to the syncing screen for that school', async ({ page }) => {
    await seed(page, {
      schools: [SCHOOL_A],
      links: [link(SCHOOL_A)],
      onCreate: async (route) => {
        await route.fulfill({ status: 201, json: link(SCHOOL_B, { lastSyncAt: null }) });
      },
    });
    await page.route('**/api/v1/auth/schools', (route) =>
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
    // Held open deliberately. `SyncingPageClient` does
    // `triggerSyncRefresh().then(leave)` and `leave()` replaces the URL with
    // /children, so a stub that answers instantly races both assertions
    // below -- this spec passed only when the machine was loaded enough for
    // the heading to render first. What it is about is the headline a linking
    // parent sees *while* the sync runs; leaving when the refresh resolves is
    // covered on its own in auth.spec.ts.
    await page.route('**/api/v1/sync/refresh*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.fulfill({ json: { status: 'success', tasks: [] } });
    });

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
  // B2's UI contract. The DoD's literal "sign in to B first, then add B from
  // A" is not reachable in this harness: `auth.setup.ts` writes a bypass
  // cookie and every spec intercepts `**/api/v1/**`, so nothing here reaches a
  // real backend. What the e2e owns is the two-step shape -- offer, confirm,
  // resubmit with the flag -- and the real end-to-end is proved against
  // Postgres and Redis in tests/integration/household-merge.test.ts.
  test('a merge is offered, confirmed, and then resubmitted with the flag', async ({
    page,
  }) => {
    const bodies: Array<Record<string, unknown>> = [];

    await seed(page, {
      schools: [SCHOOL_A],
      links: [link(SCHOOL_A)],
      onCreate: async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        bodies.push(body);
        if (body.confirmMerge === true) {
          await route.fulfill({ status: 201, json: link(SCHOOL_B, { lastSyncAt: null }) });
          return;
        }
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'MERGE_AVAILABLE',
              message: 'merge available',
              details: [],
              merge: { schoolName: SCHOOL_B.schoolName, childrenCount: 2 },
            },
          },
        });
      },
    });
    await page.route('**/api/v1/auth/schools', (route) =>
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
          run: {
            status: 'running',
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
        },
      }),
    );
    // Held open, so `leave()` cannot replace the URL before the
    // `waitForURL` below -- same race as the spec above.
    await page.route('**/api/v1/sync/refresh*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.fulfill({ json: { status: 'success', tasks: [] } });
    });

    await page.goto('/more/schools/new');
    await page.getByTestId('add-school-selector').click();
    await page.getByTestId(`school-option-${SCHOOL_B.semel}`).click();
    await page.getByTestId('add-school-username').fill('parent-b');
    await page.getByTestId('add-school-password').fill('pw');
    await page.getByTestId('add-school-submit-btn').click();

    // Not an error. A merge is something the parent can do, so the screen
    // names the action and the consequences rather than reporting a conflict.
    const confirm = page.getByTestId('add-school-merge-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(SCHOOL_B.schoolName);
    await expect(page.getByTestId('add-school-error')).toHaveCount(0);

    await page.getByTestId('add-school-merge-confirm-btn').click();

    await page.waitForURL(`**/auth/syncing?schoolId=${SCHOOL_B.id}`);
    // Resubmitted with the credentials the form still held, plus the flag.
    expect(bodies).toHaveLength(2);
    expect(bodies[0].confirmMerge).toBeUndefined();
    expect(bodies[1]).toMatchObject({
      semel: SCHOOL_B.semel,
      username: 'parent-b',
      password: 'pw',
      confirmMerge: true,
    });
  });

  // The consent and the request have to be the same thing. Reading the offer,
  // a parent may well decide the username was wrong and edit it -- the card
  // is still on screen, so clicking confirm sent the EDITED credentials under
  // a consent given for the original ones. If that other account is also
  // foreign-owned and mergeable, the backend merges a household the parent was
  // never shown.
  test('confirming sends the credentials the offer was made for', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];

    await seed(page, {
      schools: [SCHOOL_A],
      links: [link(SCHOOL_A)],
      onCreate: async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        bodies.push(body);
        if (body.confirmMerge === true) {
          await route.fulfill({ status: 201, json: link(SCHOOL_B, { lastSyncAt: null }) });
          return;
        }
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'MERGE_AVAILABLE',
              message: 'merge available',
              details: [],
              merge: { schoolName: SCHOOL_B.schoolName, childrenCount: 1 },
            },
          },
        });
      },
    });
    await page.route('**/api/v1/auth/schools', (route) =>
      route.fulfill({
        json: [{ semel: SCHOOL_B.semel, name: SCHOOL_B.schoolName, years: [2026] }],
      }),
    );
    await page.route('**/api/v1/sync/status*', (route) =>
      route.fulfill({ json: { done: true, sourcesCompleted: 17, sourcesTotal: 17, run: null } }),
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

    await expect(page.getByTestId('add-school-merge-confirm')).toBeVisible();

    // Edited after the offer. Editing the form must withdraw the offer rather
    // than silently retarget it.
    await page.getByTestId('add-school-username').fill('someone-else');

    await expect(page.getByTestId('add-school-merge-confirm')).toHaveCount(0);
    expect(bodies).toHaveLength(1);
  });

  test('a parent can back out of a merge without it happening', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];

    await seed(page, {
      schools: [SCHOOL_A],
      links: [link(SCHOOL_A)],
      onCreate: async (route) => {
        bodies.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'MERGE_AVAILABLE',
              message: 'merge available',
              details: [],
              merge: { schoolName: SCHOOL_B.schoolName, childrenCount: 1 },
            },
          },
        });
      },
    });
    await page.route('**/api/v1/auth/schools', (route) =>
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

    await expect(page.getByTestId('add-school-merge-confirm')).toBeVisible();
    await page.getByTestId('add-school-merge-cancel-btn').click();

    await expect(page.getByTestId('add-school-merge-confirm')).toHaveCount(0);
    // One request, and no second one carrying the flag.
    expect(bodies).toHaveLength(1);
    expect(page.url()).toContain('/more/schools/new');
  });
});
