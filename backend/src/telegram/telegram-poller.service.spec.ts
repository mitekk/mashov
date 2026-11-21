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

  it('still confirms a batch when one update threw on the way through', async () => {
    // A single malformed update must not be re-delivered forever, blocking
    // every later one behind it.
    const harness = makeHarness();
    harness.getUpdates.mockResolvedValueOnce([{ update_id: 7 }, { update_id: 8 }]);
    harness.consume.mockRejectedValueOnce(new Error('bad update'));

    await harness.service.pollOnce();
    await harness.service.pollOnce();

    expect(harness.consume).toHaveBeenCalledTimes(2);
    expect(harness.getUpdates.mock.calls[1][0]).toBe(9);
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
