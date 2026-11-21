import { TelegramPollerService } from './telegram-poller.service';
import type { ConfigService } from '@nestjs/config';
import type { TelegramClient } from './telegram.client';
import type { TelegramLinkService } from './telegram-link.service';

interface HarnessOptions {
  hasToken?: boolean;
  env?: Record<string, string>;
  nodeEnv?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const getUpdates = jest.fn().mockResolvedValue([]);
  const client = {
    hasToken: jest.fn().mockReturnValue(options.hasToken ?? true),
    getUpdates,
  } as unknown as TelegramClient;

  const consume = jest.fn().mockResolvedValue(undefined);
  const links = { consume } as unknown as TelegramLinkService;

  const config = {
    get: jest.fn((key: string) => (options.env ?? {})[key]),
  } as unknown as ConfigService;

  const service = new TelegramPollerService(client, links, config);
  return { service, client, links, config, getUpdates, consume };
}

describe('TelegramPollerService.shouldPoll', () => {
  const realNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it('stays inert with no bot token, which is the default deployment', () => {
    // Token absence is checked before any loop starts: a poller that tried
    // anyway would crash-loop on every deployment that has no bot.
    process.env.NODE_ENV = 'production';
    const harness = makeHarness({ hasToken: false });

    expect(harness.service.shouldPoll()).toBe(false);
  });

  it('polls when a token is configured', () => {
    process.env.NODE_ENV = 'production';

    expect(makeHarness().service.shouldPoll()).toBe(true);
  });

  it('can be switched off explicitly even with a token present', () => {
    process.env.NODE_ENV = 'production';
    const harness = makeHarness({ env: { TELEGRAM_POLL_ENABLED: 'false' } });

    expect(harness.service.shouldPoll()).toBe(false);
  });

  it('never polls under the test runner', () => {
    process.env.NODE_ENV = 'test';

    expect(makeHarness().service.shouldPoll()).toBe(false);
  });

  it('starts no loop at all when it should not poll', () => {
    process.env.NODE_ENV = 'test';
    const harness = makeHarness();

    harness.service.onModuleInit();

    expect(harness.getUpdates).not.toHaveBeenCalled();
  });
});

describe('TelegramPollerService.pollOnce', () => {
  it('sends no offset on the very first poll', async () => {
    const harness = makeHarness();

    await harness.service.pollOnce();

    expect(harness.getUpdates).toHaveBeenCalledWith(undefined, 30);
  });

  it('honours a configured poll timeout', async () => {
    const harness = makeHarness({ env: { TELEGRAM_POLL_TIMEOUT_SECONDS: '5' } });

    await harness.service.pollOnce();

    expect(harness.getUpdates).toHaveBeenCalledWith(undefined, 5);
  });

  it('ignores a poll timeout that is not a positive number', async () => {
    const harness = makeHarness({ env: { TELEGRAM_POLL_TIMEOUT_SECONDS: 'thirty' } });

    await harness.service.pollOnce();

    expect(harness.getUpdates).toHaveBeenCalledWith(undefined, 30);
  });

  it('hands each update to the link service', async () => {
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValue([{ update_id: 7 }, { update_id: 8 }]);

    await harness.service.pollOnce();

    expect(harness.consume).toHaveBeenCalledTimes(2);
    expect(harness.consume.mock.calls[0][0]).toEqual({ update_id: 7 });
  });

  it('confirms the batch by advancing past the highest update id', async () => {
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValueOnce([{ update_id: 7 }, { update_id: 9 }]);

    await harness.service.pollOnce();
    await harness.service.pollOnce();

    expect(harness.getUpdates.mock.calls[1][0]).toBe(10);
  });

  it('does not rewind the offset when a later batch is empty', async () => {
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValueOnce([{ update_id: 9 }]);

    await harness.service.pollOnce();
    await harness.service.pollOnce();
    await harness.service.pollOnce();

    expect(harness.getUpdates.mock.calls[2][0]).toBe(10);
  });

  it('processes the rest of a batch when one update threw, without confirming it', async () => {
    // Later updates are still handed over -- one bad update must not block the
    // batch behind it -- but the offset stops at the failed one so Telegram
    // hands it back. Abandoning it takes repeated failures, not one.
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValueOnce([{ update_id: 7 }, { update_id: 8 }]);
    harness.consume.mockRejectedValueOnce(new Error('bad update'));

    await harness.service.pollOnce();
    await harness.service.pollOnce();

    // Both updates in the batch were handed over, 8 included.
    expect(harness.consume).toHaveBeenCalledTimes(2);
    expect(harness.getUpdates.mock.calls[1][0]).toBe(7);
  });

  it('ignores an update with no numeric id rather than confirming it away', async () => {
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValueOnce([{ nonsense: true }]);

    await harness.service.pollOnce();
    await harness.service.pollOnce();

    expect(harness.getUpdates.mock.calls[1][0]).toBeUndefined();
  });
});

describe('TelegramPollerService error handling', () => {
  it('stops for good when a webhook is active on the same bot', async () => {
    // getUpdates and a webhook are mutually exclusive on one bot, so this is a
    // configuration error, not something to retry.
    const harness = makeHarness();
    harness.getUpdates.mockRejectedValue(
      new Error("Telegram getUpdates failed: Conflict: can't use getUpdates method while webhook is active"),
    );

    await harness.service.pollOnce();

    expect(harness.service.isStopped()).toBe(true);
  });

  it('keeps going after a transient failure', async () => {
    const harness = makeHarness();
    harness.getUpdates.mockRejectedValue(new Error('Telegram getUpdates failed: HTTP 502'));

    await harness.service.pollOnce();

    expect(harness.service.isStopped()).toBe(false);
  });

  it('does not poll again once it has been shut down', async () => {
    const harness = makeHarness();

    harness.service.onModuleDestroy();
    await harness.service.pollOnce();

    expect(harness.getUpdates).not.toHaveBeenCalled();
  });
});

describe('TelegramPollerService — review findings', () => {
  describe('the loop cannot die silently (finding 7)', () => {
    it('survives a result that is not an array at all', async () => {
      // `{ ok: true, result: {} }` used to make the for...of throw, pollOnce
      // reject, and scheduleNext -- which lives in a .then() -- never run. The
      // process kept serving HTTP while every parent's START was ignored, with
      // `stopped` still false so isStopped() lied about it.
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue({} as never);

      await expect(harness.service.pollOnce()).resolves.toEqual(expect.any(Number));
      expect(harness.service.isStopped()).toBe(false);
    });

    it('books the next poll even when one blows up outside the guarded blocks', async () => {
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue(null as never);

      const delay = await harness.service.pollOnce();

      expect(typeof delay).toBe('number');
    });

    it('keeps polling after an update throws, rather than stopping', async () => {
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue([{ update_id: 7 }]);
      harness.consume.mockRejectedValue(new Error('boom'));

      await harness.service.pollOnce();

      expect(harness.service.isStopped()).toBe(false);
    });
  });

  describe('a transient failure does not lose the START (finding 8)', () => {
    it('does not confirm an update whose processing failed', async () => {
      // Postgres restarting as the START arrives: consume throws, and
      // pre-advancing the offset would tell Telegram to drop the update. The
      // 24-hour retention the in-memory offset relies on would never apply,
      // and the parent would sit on step 3 until the code expired.
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue([{ update_id: 7 }]);
      harness.consume.mockRejectedValueOnce(new Error('connection pool timeout'));

      await harness.service.pollOnce();
      await harness.service.pollOnce();

      // Offset left AT 7, not past it: everything before 7 is confirmed, 7
      // itself is not, so Telegram hands it back.
      expect(harness.getUpdates.mock.calls[1][0]).toBe(7);
      expect(harness.consume).toHaveBeenCalledTimes(2);
    });

    it('confirms the update once a retry succeeds', async () => {
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue([{ update_id: 7 }]);
      harness.consume.mockRejectedValueOnce(new Error('connection pool timeout'));

      await harness.service.pollOnce();
      await harness.service.pollOnce();
      await harness.service.pollOnce();

      expect(harness.getUpdates.mock.calls[2][0]).toBe(8);
    });

    it('gives up on an update that fails repeatedly rather than stalling forever', async () => {
      // The other half: a genuinely malformed update must not be re-delivered
      // for 24 hours with every later one stuck behind it.
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue([{ update_id: 7 }]);
      harness.consume.mockRejectedValue(new Error('always broken'));

      await harness.service.pollOnce();
      await harness.service.pollOnce();
      await harness.service.pollOnce();
      await harness.service.pollOnce();

      expect(harness.getUpdates.mock.calls[3][0]).toBe(8);
    });

    it('gives a recovered update a fresh retry budget', async () => {
      // The attempt counter is cleared on success. Without that, the two
      // failures below would land on a count that had never been reset and the
      // update would be abandoned on its third-ever failure rather than its
      // third consecutive one.
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValue([{ update_id: 7 }]);

      harness.consume.mockRejectedValueOnce(new Error('transient'));
      await harness.service.pollOnce();
      await harness.service.pollOnce(); // succeeds, clearing the count
      harness.consume
        .mockRejectedValueOnce(new Error('transient'))
        .mockRejectedValueOnce(new Error('transient'));
      await harness.service.pollOnce();
      await harness.service.pollOnce();

      // Two consecutive failures after the reset, so still being retried
      // rather than abandoned on a third cumulative one.
      expect(harness.getUpdates.mock.calls[3][0]).toBe(7);
    });

    it('still confirms a batch of updates that all succeeded', async () => {
      const harness = makeHarness();
      harness.getUpdates.mockResolvedValueOnce([{ update_id: 7 }, { update_id: 9 }]);

      await harness.service.pollOnce();
      await harness.service.pollOnce();

      expect(harness.getUpdates.mock.calls[1][0]).toBe(10);
    });
  });
});
