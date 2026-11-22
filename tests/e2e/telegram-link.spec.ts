import { test, expect, type Page, type Route } from '@playwright/test';
import { TelegramSetupPage } from './pages/TelegramSetupPage';

/**
 * The parent-driven Telegram link, end to end in a real browser (ADR-0033).
 *
 * What only this layer can show: that the wizard's third step advances **by
 * itself** when the backend reports the chat bound. There is no "I pressed it"
 * button -- the poll is the mechanism -- and a component test proves the stop
 * condition while this proves the screen actually moves.
 *
 * Telegram itself is never reached here, in CI or locally: the bot's own API
 * needs a token and a human pressing START on a phone. What is mocked is this
 * app's routes; what is exercised is every line of our own wiring between the
 * card, the wizard, the poll and the subscription rows.
 */

const STUDENT_A = 'tg-student-guid-1';
const STUDENT_B = 'tg-student-guid-2';
const CODE = 'tg0123456789abcdef0123456789abcd';
const DEEP_LINK = `https://t.me/mashov_e2e_bot?start=${CODE}`;

type LinkStatus = 'pending' | 'linked' | 'expired';

interface LinkState {
  status: LinkStatus;
  linkedAt: string | null;
  recipientCount: number;
  confirmationSent: boolean;
  confirmationPending: boolean;
  confirmationError: string | null;
  subscribedGuids: string[];
  deliveryEnabled: boolean;
}

function linkState(overrides: Partial<LinkState> = {}): LinkState {
  return {
    status: 'pending',
    linkedAt: null,
    recipientCount: 0,
    confirmationSent: false,
    confirmationPending: false,
    confirmationError: null,
    subscribedGuids: [],
    deliveryEnabled: true,
    ...overrides,
  };
}

interface RecipientRow {
  id: string;
  studentGuid: string;
  channel: string;
  enabled: boolean;
}

function recipient(overrides: Partial<RecipientRow> & Pick<RecipientRow, 'id'>): RecipientRow {
  return {
    studentGuid: STUDENT_A,
    channel: 'telegram',
    enabled: true,
    ...overrides,
  };
}

function child(studentGuid: string, fullName: string) {
  return {
    studentGuid,
    privateName: fullName.split(' ')[0],
    familyName: fullName.split(' ')[1] ?? '',
    fullName,
    classCode: 'ז',
    classNum: 3,
    gender: 'נ',
    isActive: true,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    subjectCount: 0,
    latestUpdateAt: null,
    schoolId: 'conn-1',
    schoolName: 'תיכון הרצוג',
    schoolShortLabel: 'הרצוג',
    semel: 540175,
  };
}

/** What the mocked backend did, so a test can assert on the contract. */
interface Calls {
  mintBodies: { studentGuids: string[] }[];
  statusReads: number;
  patches: { id: string; body: Record<string, unknown> }[];
  disconnects: number;
}

interface SeedOptions {
  /** Subscription rows the card starts with. Empty = "not connected". */
  recipients?: RecipientRow[];
  /**
   * What `GET telegram-links/:code` answers, one entry per read; the last entry
   * repeats. A one-entry list is therefore a steady state, and a two-entry list
   * is the parent pressing START between two polls.
   */
  states?: LinkState[];
  /** A non-201 answer from the mint route, e.g. the 503 with no bot token. */
  mintFailure?: { status: number; body: unknown };
  /** A non-2xx answer from the per-child toggle. */
  patchFailure?: { status: number; body: unknown };
}

async function seed(page: Page, options: SeedOptions = {}): Promise<Calls> {
  const calls: Calls = { mintBodies: [], statusReads: 0, patches: [], disconnects: 0 };
  let rows = [...(options.recipients ?? [])];
  const states = options.states ?? [linkState()];

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // Registered FIRST, so every specific route below takes precedence --
  // school-links.spec's reasoning, and it matters more here than anywhere: an
  // endpoint this spec does not anticipate reaches the real backend, answers
  // 401, and apiFetch's global handler sends the browser to /auth/sign-in,
  // which looks exactly like a wizard that refused to open.
  await page.route('**/api/v1/**', (route) =>
    json(route, { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
  );

  await page.route('**/api/v1/auth/me', (route) =>
    json(route, {
      mashovUserId: 'tg-parent-1',
      username: 'tg-parent',
      displayName: 'הורה',
      schools: [
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'תיכון הרצוג',
          shortLabel: 'הרצוג',
          schoolYear: 2026,
        },
      ],
    }),
  );

  // The app shell reads `freshness.state`, and the catch-all's list envelope
  // has no freshness at all -- an undefined read, not an empty screen.
  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        unreadConversations: 0,
        recentHomeworkCount: 0,
        recentBehaviorCount: 0,
        childrenCount: 2,
      },
      feed: [],
      children: [],
    }),
  );

  // The rest of the /more shell. The catch-all above answers these with a
  // paginated-list envelope, which is the wrong shape for both of them -- and
  // the page renders `health.sources` and `profiles[0]` directly, so the wrong
  // shape is a client-side exception rather than an empty card.
  await page.route('**/api/v1/settings/source-health', (route) =>
    json(route, { sources: [], overallState: 'fresh', lastFullSyncAt: null }),
  );

  await page.route('**/api/v1/settings/profile', (route) =>
    json(route, [
      {
        householdConnectionId: 'conn-1',
        upstreamUserId: 'tg-parent-1',
        displayName: 'הורה',
        email: '',
        cellphone: '',
        schoolName: 'תיכון הרצוג',
        schoolYear: 2026,
        schoolCode: 540175,
        detailsState: 1,
        updatedAt: new Date().toISOString(),
      },
    ]),
  );

  await page.route('**/api/v1/school-links', (route) =>
    json(route, {
      data: [
        {
          id: 'conn-1',
          semel: 540175,
          schoolName: 'תיכון הרצוג',
          shortLabel: 'הרצוג',
          schoolYear: 2026,
          username: 'tg-parent',
          childrenCount: 2,
          isPrimary: true,
          lastLoginAt: new Date().toISOString(),
          lastSyncAt: new Date().toISOString(),
          active: true,
        },
      ],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    }),
  );

  await page.route('**/api/v1/children', (route) =>
    json(route, { data: [child(STUDENT_A, 'מיקה קורס'), child(STUDENT_B, 'יואב קורס')] }),
  );

  // One handler for the collection and the per-child item alike: both match any
  // glob that covers `?limit=100`, so branching on the method here is clearer
  // than relying on which route was registered last.
  await page.route('**/api/v1/digest/recipients**', async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const id = new URL(request.url()).pathname.split('/').pop() ?? '';
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.patches.push({ id, body });
      if (options.patchFailure) {
        return json(route, options.patchFailure.body, options.patchFailure.status);
      }
      rows = rows.map((row) =>
        row.id === id ? { ...row, enabled: Boolean(body.enabled) } : row,
      );
      return json(route, { data: rows.find((row) => row.id === id) });
    }
    return json(route, {
      data: rows,
      pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 },
    });
  });

  await page.route('**/api/v1/digest/telegram-links**', async (route) => {
    const request = route.request();

    if (request.method() === 'POST') {
      calls.mintBodies.push(request.postDataJSON() as { studentGuids: string[] });
      if (options.mintFailure) {
        return json(route, options.mintFailure.body, options.mintFailure.status);
      }
      return json(
        route,
        {
          data: {
            code: CODE,
            deepLink: DEEP_LINK,
            botUsername: 'mashov_e2e_bot',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          },
        },
        201,
      );
    }

    if (request.method() === 'DELETE') {
      calls.disconnects += 1;
      rows = [];
      return route.fulfill({ status: 204, body: '' });
    }

    // The wizard's poll. Answers the next state in the list and then holds on
    // the last one, which is how "the parent pressed START" is expressed.
    const state = states[Math.min(calls.statusReads, states.length - 1)];
    calls.statusReads += 1;
    if (state.status === 'linked') {
      rows = state.subscribedGuids.map((studentGuid, index) =>
        recipient({ id: `rec-${index + 1}`, studentGuid }),
      );
    }
    return json(route, { data: state });
  });

  return calls;
}

test.describe('Telegram updates — the parent-driven link', () => {
  test('a parent connects their own Telegram without typing anything', async ({ page }) => {
    const calls = await seed(page, {
      states: [
        linkState({ status: 'pending' }),
        linkState({
          status: 'linked',
          linkedAt: new Date().toISOString(),
          recipientCount: 2,
          confirmationSent: true,
          subscribedGuids: [STUDENT_A, STUDENT_B],
        }),
      ],
    });
    const telegram = new TelegramSetupPage(page);

    // /more offers it to a parent who has never connected.
    await telegram.openMore();
    await expect(telegram.connectLink).toBeVisible();

    await telegram.reachStartStep();

    // Both children were already ticked: the parent chose nothing, which is the
    // whole point of the default.
    expect(calls.mintBodies).toHaveLength(1);
    expect(calls.mintBodies[0].studentGuids.sort()).toEqual([STUDENT_A, STUDENT_B].sort());

    // The deep link is the bot's own, built from the code the server minted --
    // nothing for the parent to copy, search for or retype.
    await expect(telegram.startButton).toHaveAttribute('href', DEEP_LINK);
    await expect(telegram.startWaiting).toBeVisible();

    // No click here, and that is the assertion: the parent pressed START in
    // another app, and this screen moves on its own when the poll sees it.
    await expect(telegram.doneStep).toBeVisible({ timeout: 15_000 });
    // First names, the way the step's own copy addresses them.
    await expect(telegram.doneChildren).toContainText('מיקה');
    await expect(telegram.doneChildren).toContainText('יואב');

    // And the card now shows what the link produced.
    await telegram.doneBackButton.click();
    await expect(telegram.cardRow(STUDENT_A)).toBeVisible();
    await expect(telegram.cardRow(STUDENT_B)).toBeVisible();
    await expect(telegram.connectLink).toHaveCount(0);
  });

  test('says plainly that sending is off rather than promising briefings', async ({ page }) => {
    // DIGEST_ENABLED is false by default, so this is the common deployment --
    // and a parent who finished the wizard and then heard nothing would have
    // every reason to think the link failed.
    await seed(page, {
      states: [
        // Pending first: a list that starts `linked` would have the wizard skip
        // step 3 entirely, and then this test would not be walking the journey
        // a parent walks.
        linkState({ status: 'pending' }),
        linkState({
          status: 'linked',
          linkedAt: new Date().toISOString(),
          recipientCount: 1,
          confirmationSent: true,
          subscribedGuids: [STUDENT_A],
          deliveryEnabled: false,
        }),
      ],
    });
    const telegram = new TelegramSetupPage(page);

    await telegram.reachStartStep();

    await expect(telegram.doneStep).toBeVisible({ timeout: 15_000 });
    await expect(telegram.doneDeliveryOff).toBeVisible();
  });

  test('offers a fresh code when the parent comes back too late', async ({ page }) => {
    const calls = await seed(page, { states: [linkState({ status: 'expired' })] });
    const telegram = new TelegramSetupPage(page);

    await telegram.reachStartStep();

    await expect(telegram.startRetryButton).toBeVisible({ timeout: 15_000 });
    // A dead code is not a dead end: the expired screen mints again from here.
    await telegram.startRetryButton.click();

    await expect.poll(() => calls.mintBodies.length).toBe(2);
  });

  test('tells the parent when the server has no bot configured', async ({ page }) => {
    await seed(page, {
      mintFailure: {
        status: 503,
        body: {
          error: {
            code: 'TELEGRAM_NOT_CONFIGURED',
            message: 'Telegram is not configured on this server',
            details: [],
          },
        },
      },
    });
    const telegram = new TelegramSetupPage(page);

    await telegram.reachChildrenStep();
    await telegram.childrenContinueButton.click();

    // Stays put with an explanation rather than advancing to a t.me/undefined.
    await expect(telegram.childrenError).toBeVisible();
    await expect(telegram.childrenStep).toBeVisible();
    await expect(telegram.startStep).toHaveCount(0);
  });

  test('turns one child off from /more and leaves the other subscribed', async ({ page }) => {
    const calls = await seed(page, {
      recipients: [
        recipient({ id: 'rec-1', studentGuid: STUDENT_A }),
        recipient({ id: 'rec-2', studentGuid: STUDENT_B }),
      ],
    });
    const telegram = new TelegramSetupPage(page);

    await telegram.openMore();
    await expect(telegram.cardToggle(STUDENT_A)).toBeChecked();

    await telegram.cardToggle(STUDENT_A).click();

    await expect.poll(() => calls.patches).toEqual([{ id: 'rec-1', body: { enabled: false } }]);
    await expect(telegram.cardToggle(STUDENT_A)).not.toBeChecked();
    await expect(telegram.cardToggle(STUDENT_B)).toBeChecked();
  });

  test('disconnects only after the parent confirms it', async ({ page }) => {
    const calls = await seed(page, {
      recipients: [recipient({ id: 'rec-1', studentGuid: STUDENT_A })],
    });
    const telegram = new TelegramSetupPage(page);

    await telegram.openMore();
    await telegram.disconnectButton.click();
    await expect(telegram.disconnectModal).toBeVisible();

    // Backing out sends nothing: this throws away every child's subscription.
    await telegram.cancelDisconnectButton.click();
    await expect(telegram.disconnectModal).toHaveCount(0);
    expect(calls.disconnects).toBe(0);

    await telegram.disconnectButton.click();
    await telegram.confirmDisconnectButton.click();

    await expect.poll(() => calls.disconnects).toBe(1);
    // Back to the invitation, so a parent can connect again.
    await expect(telegram.connectLink).toBeVisible();
  });
});
