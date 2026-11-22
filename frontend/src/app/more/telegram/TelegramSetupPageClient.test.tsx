import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildListItem, TelegramLink, TelegramLinkState } from '@/types/api';
import { ApiError } from '@/api/client';
import TelegramSetupPageClient, { wizardView } from './TelegramSetupPageClient';

const back = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, push: vi.fn(), replace: vi.fn() }),
}));

const fetchChildren = vi.fn();
vi.mock('@/api/children', () => ({
  fetchChildren: (...args: unknown[]) => fetchChildren(...args),
}));

const fetchDigestRecipients = vi.fn();
vi.mock('@/api/digest', () => ({
  fetchDigestRecipients: (...args: unknown[]) => fetchDigestRecipients(...args),
  updateDigestRecipient: vi.fn(),
}));

const createTelegramLink = vi.fn();
const fetchTelegramLinkState = vi.fn();
vi.mock('@/api/telegram', () => ({
  createTelegramLink: (...args: unknown[]) => createTelegramLink(...args),
  fetchTelegramLinkState: (...args: unknown[]) => fetchTelegramLinkState(...args),
  disconnectTelegram: vi.fn(),
}));

function child(overrides: Partial<ChildListItem> & Pick<ChildListItem, 'studentGuid'>): ChildListItem {
  return {
    privateName: 'מיקה',
    familyName: 'קורס',
    fullName: 'מיקה קורס',
    classCode: 'ז',
    classNum: 3,
    gender: 'נ',
    isActive: true,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    neutralBehaviorCount: 0,
    subjectCount: 0,
    latestUpdateAt: null,
    schoolId: 'conn-1',
    schoolName: 'תיכון הרצוג',
    schoolShortLabel: 'הרצוג',
    semel: 111,
    ...overrides,
  };
}

const LINK: TelegramLink = {
  code: 'deadbeef',
  deepLink: 'https://t.me/mashov_bot?start=deadbeef',
  botUsername: 'mashov_bot',
  expiresAt: '2026-11-21T10:15:00Z',
};

function linkState(overrides: Partial<TelegramLinkState> = {}): TelegramLinkState {
  return {
    status: 'pending',
    linkedAt: null,
    recipientCount: 0,
    confirmationSent: false,
    confirmationPending: false,
    confirmationError: null,
    subscribedGuids: ['stu-1', 'stu-2'],
    deliveryEnabled: true,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TelegramSetupPageClient />
    </QueryClientProvider>,
  );
}

/** Step 1 → step 2. */
async function reachChildStep() {
  renderPage();
  await screen.findByTestId('telegram-step-intro');
  fireEvent.click(screen.getByTestId('telegram-intro-continue-btn'));
  await screen.findByTestId('telegram-step-children');
}

/** Step 1 → step 2 → step 3, with the mint resolving. */
async function reachStartStep() {
  await reachChildStep();
  fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));
  await screen.findByTestId('telegram-step-start');
}

describe('wizardView', () => {
  it('shows the loader while the roster is still arriving on the first two steps', () => {
    expect(wizardView({ isLoading: true, isError: false, step: 'intro' })).toBe('loading');
    expect(wizardView({ isLoading: true, isError: false, step: 'children' })).toBe('loading');
  });

  it('keeps the step on screen once a link is in flight, loader or not', () => {
    // Steps 3 and 4 are a wait on an external action. Replacing them with a
    // spinner because the roster query happened to be refetching would strand
    // a parent who has already pressed START -- and rendering both at once,
    // which is what the step conditions used to do, is no better.
    expect(wizardView({ isLoading: true, isError: false, step: 'start' })).toBe('step');
    expect(wizardView({ isLoading: true, isError: false, step: 'done' })).toBe('step');
  });

  it('shows one thing at a time, never a loader beside a step', () => {
    expect(wizardView({ isLoading: false, isError: false, step: 'children' })).toBe('step');
  });

  it('reports a roster failure on every step', () => {
    expect(wizardView({ isLoading: false, isError: true, step: 'intro' })).toBe('error');
    expect(wizardView({ isLoading: true, isError: true, step: 'done' })).toBe('error');
  });
});

describe('TelegramSetupPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    back.mockReset();
    fetchChildren.mockResolvedValue({ data: [child({ studentGuid: 'stu-1' })] });
    fetchDigestRecipients.mockResolvedValue([]);
    createTelegramLink.mockResolvedValue(LINK);
    fetchTelegramLinkState.mockResolvedValue(linkState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('step 1 — what this is', () => {
    it('explains that nothing is sent on a quiet day', async () => {
      renderPage();

      const intro = await screen.findByTestId('telegram-step-intro');

      expect(intro.textContent).toMatch(/לא תקבלו הודעה/);
    });

    it('does not name a child before the parent has been asked', async () => {
      renderPage();
      await screen.findByTestId('telegram-step-intro');

      expect(screen.queryByTestId('telegram-child-toggle-stu-1')).toBeNull();
    });

    it('explains bots, chat ids and tokens nowhere', async () => {
      // A parent never needs those words, and this is the step most likely to
      // drift back towards them.
      renderPage();

      const intro = await screen.findByTestId('telegram-step-intro');

      expect(intro.textContent ?? '').not.toMatch(/בוט|טוקן|chat id|API/i);
    });
  });

  describe('step 2 — choose children', () => {
    it('pre-ticks every child the parent can see', async () => {
      fetchChildren.mockResolvedValue({ data: [
        child({ studentGuid: 'stu-1' }),
        child({ studentGuid: 'stu-2', privateName: 'יואב' }),
      ] });

      await reachChildStep();

      expect(
        (screen.getByTestId('telegram-child-toggle-stu-1') as HTMLInputElement).checked,
      ).toBe(true);
      expect(
        (screen.getByTestId('telegram-child-toggle-stu-2') as HTMLInputElement).checked,
      ).toBe(true);
    });

    it('hides the school label when there is only one school', async () => {
      // One school makes the label pure noise on every row.
      await reachChildStep();

      expect(screen.queryByTestId('telegram-child-school-stu-1')).toBeNull();
    });

    it('labels each child with its school when the parent has more than one', async () => {
      fetchChildren.mockResolvedValue({ data: [
        child({ studentGuid: 'stu-1' }),
        child({
          studentGuid: 'stu-2',
          schoolId: 'conn-2',
          schoolShortLabel: 'אורט',
          semel: 222,
        }),
      ] });

      await reachChildStep();

      expect(screen.getByTestId('telegram-child-school-stu-1').textContent).toContain('הרצוג');
      expect(screen.getByTestId('telegram-child-school-stu-2').textContent).toContain('אורט');
    });

    it('cannot continue with nobody chosen', async () => {
      await reachChildStep();

      fireEvent.click(screen.getByTestId('telegram-child-toggle-stu-1'));

      expect(
        (screen.getByTestId('telegram-children-continue-btn') as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('mints a link for exactly the children still ticked', async () => {
      fetchChildren.mockResolvedValue({ data: [
        child({ studentGuid: 'stu-1' }),
        child({ studentGuid: 'stu-2' }),
      ] });
      await reachChildStep();

      fireEvent.click(screen.getByTestId('telegram-child-toggle-stu-2'));
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await waitFor(() => expect(createTelegramLink).toHaveBeenCalledWith(['stu-1']));
    });

    it('says plainly when this server has no Telegram set up', async () => {
      // Better than a t.me/undefined link that sends the parent to Telegram to
      // be told the bot does not exist.
      createTelegramLink.mockRejectedValue(
        new ApiError(503, 'not configured', {
          error: { code: 'TELEGRAM_NOT_CONFIGURED' },
        }),
      );
      await reachChildStep();

      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const error = await screen.findByTestId('telegram-children-error');
      expect(error.textContent).toMatch(/לא מוגדר|לא זמין/);
      expect(screen.queryByTestId('telegram-step-start')).toBeNull();
    });

    it('offers no children at all to a parent whose roster is empty', async () => {
      fetchChildren.mockResolvedValue({ data: [] });
      await reachChildStep();

      expect(screen.getByTestId('telegram-children-empty')).toBeTruthy();
      expect(
        (screen.getByTestId('telegram-children-continue-btn') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  describe('step 3 — press START', () => {
    it('sends the parent to the minted deep link', async () => {
      await reachStartStep();

      const button = screen.getByTestId('telegram-start-btn') as HTMLAnchorElement;
      expect(button.getAttribute('href')).toBe(LINK.deepLink);
    });

    it('waits for the parent rather than asking them to confirm they did it', async () => {
      // The poll knows. A "I pressed it" button would be a second thing to get
      // wrong.
      await reachStartStep();

      expect(screen.getByTestId('telegram-start-waiting')).toBeTruthy();
      expect(screen.queryByTestId('telegram-start-done-btn')).toBeNull();
    });

    it('says the link does not stay valid forever', async () => {
      await reachStartStep();

      expect(screen.getByTestId('telegram-step-start').textContent).toMatch(/תוקף|פג|דקות/);
    });

    it('offers a fresh link once the code has expired', async () => {
      fetchTelegramLinkState.mockResolvedValue(linkState({ status: 'expired' }));
      await reachStartStep();

      const retry = await screen.findByTestId('telegram-start-retry-btn');
      fireEvent.click(retry);

      await waitFor(() => expect(createTelegramLink).toHaveBeenCalledTimes(2));
    });
  });

  describe('step 4 — confirmation', () => {
    it('advances by itself once the chat is linked', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, recipientCount: 1 }),
      );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await screen.findByTestId('telegram-step-done');
    });

    it('refetches the subscriptions once the chat is bound', async () => {
      // The link is created server-side, by the poller reading the START --
      // there is no client mutation to hang an invalidation off. Without this,
      // `useDigestRecipients`' 60s staleTime means a parent who finishes the
      // wizard and taps "back to settings" is told they are not connected,
      // seconds after connecting. Found by the e2e journey, which walks back
      // to /more and reads the card.
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, recipientCount: 1 }),
      );
      await reachChildStep();
      const before = fetchDigestRecipients.mock.calls.length;
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await screen.findByTestId('telegram-step-done');

      await waitFor(() =>
        expect(fetchDigestRecipients.mock.calls.length).toBeGreaterThan(before),
      );
    });

    it('tells the parent to check the message actually arrived', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, recipientCount: 1 }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const done = await screen.findByTestId('telegram-step-done');

      expect(done.textContent).toMatch(/הודעה/);
    });

    it('names the children now subscribed', async () => {
      fetchChildren.mockResolvedValue({ data: [
        child({ studentGuid: 'stu-1', privateName: 'מיקה' }),
        child({ studentGuid: 'stu-2', privateName: 'יואב' }),
      ] });
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, recipientCount: 2 }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const names = await screen.findByTestId('telegram-done-children');

      expect(names.textContent).toContain('מיקה');
      expect(names.textContent).toContain('יואב');
    });

    it('says sending is off rather than promising briefings', async () => {
      // DIGEST_ENABLED is false by default, so without this a parent could
      // finish the wizard and never hear anything.
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, deliveryEnabled: false }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const notice = await screen.findByTestId('telegram-done-delivery-off');

      expect(notice.textContent).toMatch(/כבוי|מושבת|לא נשלח/);
    });

    it('does not warn about delivery when it is actually on', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true, deliveryEnabled: true }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await screen.findByTestId('telegram-step-done');

      expect(screen.queryByTestId('telegram-done-delivery-off')).toBeNull();
    });

    it('surfaces a confirmation that could not be delivered', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({
          status: 'linked',
          confirmationSent: false,
          confirmationError: 'bot was blocked by the user',
        }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      expect(await screen.findByTestId('telegram-done-confirmation-failed')).toBeTruthy();
    });

    it('links back to the settings screen', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: true }),
      );
      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const done = await screen.findByTestId('telegram-done-back-btn');

      expect(done.getAttribute('href')).toBe('/more');
    });
  });
});

describe('TelegramSetupPageClient — review findings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    back.mockReset();
    fetchChildren.mockResolvedValue({ data: [child({ studentGuid: 'stu-1' })] });
    fetchDigestRecipients.mockResolvedValue([]);
    createTelegramLink.mockResolvedValue(LINK);
    fetchTelegramLinkState.mockResolvedValue(linkState());
  });

  describe('a confirmation still in flight is not reported as a failure (finding 4)', () => {
    it('waits rather than claiming the message did not arrive', async () => {
      // consume() writes consumedAt before it has tried to send, so a poll can
      // land on linked + not-sent + no-error. Treating that as a failure put a
      // permanent red "the message did not arrive" on a link that was working.
      fetchTelegramLinkState.mockResolvedValue(
        linkState({ status: 'linked', confirmationSent: false, confirmationPending: true }),
      );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));
      await screen.findByTestId('telegram-step-done');

      expect(screen.queryByTestId('telegram-done-confirmation-failed')).toBeNull();
      expect(screen.getByTestId('telegram-done-confirmation-pending')).toBeTruthy();
    });

    it('keeps polling until the confirmation settles, then says it arrived', async () => {
      fetchTelegramLinkState
        .mockResolvedValueOnce(
          linkState({ status: 'linked', confirmationSent: false, confirmationPending: true }),
        )
        .mockResolvedValue(
          linkState({ status: 'linked', confirmationSent: true, confirmationPending: false }),
        );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));
      await screen.findByTestId('telegram-step-done');

      // Longer than TELEGRAM_LINK_POLL_MS: the point of the test is that a
      // second poll happens at all, so it has to be allowed to.
      await waitFor(
        () => expect(screen.queryByTestId('telegram-done-confirmation-pending')).toBeNull(),
        { timeout: 5_000 },
      );
      expect(screen.queryByTestId('telegram-done-confirmation-failed')).toBeNull();
    });

    it('still reports a confirmation that genuinely failed', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({
          status: 'linked',
          confirmationSent: false,
          confirmationPending: false,
          confirmationError: 'bot was blocked by the user',
        }),
      );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      expect(await screen.findByTestId('telegram-done-confirmation-failed')).toBeTruthy();
    });
  });

  describe('step 4 names the children the server subscribed (finding 5)', () => {
    it('names only the children the link actually registered', async () => {
      // The parent ticks two; one child's roster links move households between
      // minting and START, so the server subscribes one and the Telegram
      // message correctly names one. The screen must not name two.
      fetchChildren.mockResolvedValue({
        data: [
          child({ studentGuid: 'stu-1', privateName: 'מיקה' }),
          child({ studentGuid: 'stu-2', privateName: 'יואב' }),
        ],
      });
      fetchTelegramLinkState.mockResolvedValue(
        linkState({
          status: 'linked',
          confirmationSent: true,
          recipientCount: 1,
          subscribedGuids: ['stu-1'],
        }),
      );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      const names = await screen.findByTestId('telegram-done-children');
      expect(names.textContent).toContain('מיקה');
      expect(names.textContent).not.toContain('יואב');
    });

    it('says plainly that nobody was registered rather than listing the ticks', async () => {
      fetchTelegramLinkState.mockResolvedValue(
        linkState({
          status: 'linked',
          confirmationSent: true,
          recipientCount: 0,
          subscribedGuids: [],
        }),
      );

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await screen.findByTestId('telegram-step-done');
      expect(screen.queryByTestId('telegram-done-children')).toBeNull();
      expect(screen.getByTestId('telegram-done-nobody')).toBeTruthy();
    });
  });

  describe('adding a child does not re-enable one switched off (finding 6)', () => {
    it('leaves a child the parent had switched off unticked', async () => {
      // The only way to add a child is this wizard, and it pre-ticks. With the
      // upsert setting enabled: true, one START silently resubscribed a child
      // the parent had deliberately turned off in /more.
      fetchChildren.mockResolvedValue({
        data: [
          child({ studentGuid: 'stu-1' }),
          child({ studentGuid: 'stu-2' }),
          child({ studentGuid: 'stu-3' }),
        ],
      });
      fetchDigestRecipients.mockResolvedValue([
        {
          id: 'rec-2',
          userId: 'user-1',
          studentGuid: 'stu-2',
          channel: 'telegram',
          address: '98765',
          displayName: null,
          enabled: false,
          activeFrom: '2026-11-21T10:00:00Z',
          createdAt: '2026-11-21T10:00:00Z',
          updatedAt: '2026-11-21T10:00:00Z',
        },
      ]);

      await reachChildStep();

      expect(
        (screen.getByTestId('telegram-child-toggle-stu-2') as HTMLInputElement).checked,
      ).toBe(false);
      expect(
        (screen.getByTestId('telegram-child-toggle-stu-1') as HTMLInputElement).checked,
      ).toBe(true);
      expect(
        (screen.getByTestId('telegram-child-toggle-stu-3') as HTMLInputElement).checked,
      ).toBe(true);
    });

    it('still mints for a switched-off child the parent ticks again', async () => {
      // Unticked is a default, not a lock: ticking it is a deliberate choice,
      // and the upsert then re-enables it.
      fetchChildren.mockResolvedValue({
        data: [child({ studentGuid: 'stu-1' }), child({ studentGuid: 'stu-2' })],
      });
      fetchDigestRecipients.mockResolvedValue([
        {
          id: 'rec-2',
          userId: 'user-1',
          studentGuid: 'stu-2',
          channel: 'telegram',
          address: '98765',
          displayName: null,
          enabled: false,
          activeFrom: '2026-11-21T10:00:00Z',
          createdAt: '2026-11-21T10:00:00Z',
          updatedAt: '2026-11-21T10:00:00Z',
        },
      ]);

      await reachChildStep();
      fireEvent.click(screen.getByTestId('telegram-child-toggle-stu-2'));
      fireEvent.click(screen.getByTestId('telegram-children-continue-btn'));

      await waitFor(() =>
        expect(createTelegramLink).toHaveBeenCalledWith(['stu-1', 'stu-2']),
      );
    });

    it('keeps an already-enabled child ticked', async () => {
      fetchDigestRecipients.mockResolvedValue([
        {
          id: 'rec-1',
          userId: 'user-1',
          studentGuid: 'stu-1',
          channel: 'telegram',
          address: '98765',
          displayName: null,
          enabled: true,
          activeFrom: '2026-11-21T10:00:00Z',
          createdAt: '2026-11-21T10:00:00Z',
          updatedAt: '2026-11-21T10:00:00Z',
        },
      ]);

      await reachChildStep();

      expect(
        (screen.getByTestId('telegram-child-toggle-stu-1') as HTMLInputElement).checked,
      ).toBe(true);
    });
  });
});
