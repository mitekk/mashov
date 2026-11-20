import { test, expect, type Page } from '@playwright/test';
import { ChildrenPage } from './pages/ChildrenPage';
import { InboxPage } from './pages/InboxPage';

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
      },
    }),
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

/** One inbox row, stamped to a school or to nobody. */
function conversationRow(
  conversationId: string,
  school: typeof SCHOOL_A | null,
): Record<string, unknown> {
  return {
    conversationId,
    subject: `נושא ${conversationId}`,
    senderNamePreview: 'מורה',
    sendTime: '2026-11-10T08:00:00Z',
    isNew: true,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    lastFetchedAt: '2026-11-10T08:05:00Z',
    schoolId: school?.id ?? null,
    schoolShortLabel: school?.shortLabel ?? null,
  };
}

/** A full first page of A's mail, so B's row cannot fit on it. */
const A_PAGE_1 = Array.from({ length: 20 }, (_, index) =>
  conversationRow(`conv-a-${index + 1}`, SCHOOL_A),
);
const B_CONVERSATION = conversationRow('conv-b-1', SCHOOL_B);

/**
 * The conversations endpoint, answering the `schoolId` the client sends.
 *
 * Reading the query string is the whole point: the catch-all in `seed` matches
 * by URL glob alone, so a handler that ignored `?schoolId=` would answer the
 * filtered request with page 1 of everything -- and make a client-side filter,
 * which never sends the param at all, look green.
 */
async function routeConversations(
  page: Page,
  options: {
    unfiltered: Array<Array<Record<string, unknown>>>;
    bySchool: Record<string, Array<Record<string, unknown>>>;
  },
): Promise<void> {
  await page.route('**/api/v1/mail/conversations*', async (route) => {
    const url = new URL(route.request().url());
    const schoolId = url.searchParams.get('schoolId');
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const pages = schoolId === null
      ? options.unfiltered
      : [options.bySchool[schoolId] ?? []];
    const data = pages[pageNumber - 1] ?? [];
    await route.fulfill({
      json: {
        data,
        pagination: {
          page: pageNumber,
          limit: 20,
          total: pages.flat().length,
          totalPages: pages.length,
        },
      },
    });
  });
}

test.describe('School filter — inbox', () => {
  test('reaches a school whose mail is not on page 1', async ({ page }) => {
    // The defect this fixes: filtering client-side over one fetched page left
    // B's mail behind an empty state with no way to load page 2, because the
    // load-more button lives inside the list the empty branch replaces.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    await routeConversations(page, {
      unfiltered: [A_PAGE_1, [B_CONVERSATION]],
      bySchool: { [SCHOOL_A.id]: A_PAGE_1, [SCHOOL_B.id]: [B_CONVERSATION] },
    });
    const inbox = new InboxPage(page);
    await inbox.navigate();
    await expect(inbox.conversationItem('conv-a-1')).toBeVisible();
    await expect(inbox.conversationItem('conv-b-1')).toHaveCount(0);

    await inbox.filterBySchool(SCHOOL_B.semel);

    await expect(inbox.conversationItem('conv-b-1')).toBeVisible();
    await expect(inbox.conversationItem('conv-a-1')).toHaveCount(0);
  });

  test('switching chips drops a selection made under the previous one', async ({ page }) => {
    // The bulk bar's count reads the raw id array, so a selection carried
    // across a chip change showed "נבחרו 2" above an archive button that then
    // acted on one row -- a count disagreeing with a destructive action.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    await routeConversations(page, {
      unfiltered: [A_PAGE_1],
      bySchool: { [SCHOOL_A.id]: A_PAGE_1, [SCHOOL_B.id]: [B_CONVERSATION] },
    });
    const inbox = new InboxPage(page);
    await inbox.navigate();
    await inbox.toggleConversationSelection('conv-a-1');
    await expect(inbox.bulkActionsBar).toBeVisible();

    await inbox.filterBySchool(SCHOOL_B.semel);

    await expect(inbox.bulkActionsBar).toHaveCount(0);
  });

  test('a school-scoped deep link still renders when /auth/me fails', async ({ page }) => {
    // The deep-link gate waits for `me`, and `useMe` has `retry: false`: a
    // non-401 failure leaves `data` undefined forever, so a gate that reads
    // "undefined" as "still loading" spins for ever -- with the error state
    // suppressed, because the query that owns `isError` never ran.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    await routeConversations(page, {
      unfiltered: [A_PAGE_1],
      bySchool: { [SCHOOL_A.id]: A_PAGE_1, [SCHOOL_B.id]: [B_CONVERSATION] },
    });
    await page.route('**/api/v1/auth/me', (route) =>
      route.fulfill({
        status: 502,
        json: { error: { code: 'UPSTREAM_ERROR', message: 'upstream', details: [] } },
      }),
    );
    const inbox = new InboxPage(page);
    await page.goto(`/inbox?school=${SCHOOL_B.semel}`);

    // No `me` means no chips and no resolvable school, so the unfiltered
    // mailbox is the honest answer -- never an indefinite spinner.
    await expect(inbox.conversationItem('conv-a-1')).toBeVisible();
  });

  test('a school with no mail gets its own empty state', async ({ page }) => {
    // Told the generic "the mailbox is empty", a parent concludes the school
    // is broken rather than that they are looking through a filter.
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    await routeConversations(page, {
      unfiltered: [A_PAGE_1],
      bySchool: { [SCHOOL_A.id]: A_PAGE_1, [SCHOOL_B.id]: [] },
    });

    await page.goto(`/inbox?school=${SCHOOL_B.semel}`);

    await expect(page.getByText('אין דואר מבית הספר הזה')).toBeVisible();
  });

  test('the filtered empty state clears the filter', async ({ page }) => {
    await seed(page, { schools: [SCHOOL_A, SCHOOL_B], children: [CHILD_A, CHILD_B] });
    await routeConversations(page, {
      unfiltered: [A_PAGE_1],
      bySchool: { [SCHOOL_A.id]: A_PAGE_1, [SCHOOL_B.id]: [] },
    });
    const inbox = new InboxPage(page);
    await page.goto(`/inbox?school=${SCHOOL_B.semel}`);
    await expect(page.getByTestId('inbox-school-filter-reset-btn')).toBeVisible();

    await page.getByTestId('inbox-school-filter-reset-btn').click();

    await expect(inbox.conversationItem('conv-a-1')).toBeVisible();
    expect(page.url()).not.toContain('school=');
  });
});
