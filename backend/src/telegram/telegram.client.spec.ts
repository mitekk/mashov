import axios, { AxiosInstance } from 'axios';
import { TelegramClient } from './telegram.client';
import type { ConfigService } from '@nestjs/config';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const TOKEN = '123456:AAHsecretvaluethatmustneverleak';

function makeClient(env: Record<string, string> = {}) {
  const config = {
    get: jest.fn((key: string) => ({ TELEGRAM_BOT_TOKEN: TOKEN, ...env })[key]),
  } as unknown as ConfigService;
  return new TelegramClient(config);
}

describe('TelegramClient', () => {
  let get: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    get = jest.fn().mockResolvedValue({ data: { ok: true, result: { username: 'mashov_bot' } } });
    mockedAxios.create.mockReturnValue({ get } as unknown as AxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);
  });

  describe('hasToken', () => {
    it('is true when a bot token is configured', () => {
      expect(makeClient().hasToken()).toBe(true);
    });

    it('is false when the token is missing', () => {
      expect(makeClient({ TELEGRAM_BOT_TOKEN: '' }).hasToken()).toBe(false);
    });

    it('is false when the token is only whitespace', () => {
      expect(makeClient({ TELEGRAM_BOT_TOKEN: '   ' }).hasToken()).toBe(false);
    });
  });

  describe('getMe', () => {
    it("reads the bot's own username from Telegram", async () => {
      // The username is never configured by hand: NEXT_PUBLIC_* is inlined at
      // build time so a compose env var would never reach the browser, and
      // asking Telegram means the username cannot drift from the deployed token.
      const username = await makeClient().getMe();

      expect(username).toBe('mashov_bot');
      expect(get.mock.calls[0][0]).toContain('getMe');
    });

    it('asks Telegram once and serves every later caller from memory', async () => {
      const client = makeClient();

      await client.getMe();
      await client.getMe();

      expect(get).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure, so a transient outage is retried', async () => {
      const client = makeClient();
      get.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(client.getMe()).rejects.toThrow(/socket hang up/);

      expect(await client.getMe()).toBe('mashov_bot');
    });

    it('refuses to call Telegram at all with no token configured', async () => {
      const client = makeClient({ TELEGRAM_BOT_TOKEN: '' });

      await expect(client.getMe()).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
      expect(get).not.toHaveBeenCalled();
    });

    it('never puts the bot token in the error it throws', async () => {
      const client = makeClient();
      get.mockRejectedValue(
        new Error(`Request failed: https://api.telegram.org/bot${TOKEN}/getMe`),
      );

      await expect(client.getMe()).rejects.not.toThrow(/AAHsecret/);
    });

    it("reports Telegram's own reason when it answers ok=false", async () => {
      const client = makeClient();
      get.mockResolvedValue({ data: { ok: false, description: 'Unauthorized' } });

      await expect(client.getMe()).rejects.toThrow(/Unauthorized/);
    });

    it('reports a bot with no username rather than caching undefined', async () => {
      const client = makeClient();
      get.mockResolvedValue({ data: { ok: true, result: {} } });

      await expect(client.getMe()).rejects.toThrow(/username/i);
    });
  });
});

describe('TelegramClient.getUpdates', () => {
  let get: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    get = jest.fn().mockResolvedValue({ data: { ok: true, result: [{ update_id: 42 }] } });
    mockedAxios.create.mockReturnValue({ get } as unknown as AxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);
  });

  it('long-polls Telegram and returns the updates it was handed', async () => {
    const updates = await makeClient().getUpdates(undefined, 30);

    expect(get.mock.calls[0][0]).toContain('getUpdates');
    expect(updates).toEqual([{ update_id: 42 }]);
  });

  it('sends no offset on the first poll, so nothing is confirmed by accident', async () => {
    await makeClient().getUpdates(undefined, 30);

    expect(get.mock.calls[0][1].params.offset).toBeUndefined();
  });

  it('passes the offset that confirms everything before it', async () => {
    // Passing offset = lastUpdateId + 1 is what tells Telegram to drop those
    // updates; unconfirmed ones it keeps for 24 hours.
    await makeClient().getUpdates(43, 30);

    expect(get.mock.calls[0][1].params.offset).toBe(43);
  });

  it('asks Telegram to hold the connection open for the poll timeout', async () => {
    await makeClient().getUpdates(undefined, 30);

    expect(get.mock.calls[0][1].params.timeout).toBe(30);
  });

  it('allows the HTTP read to outlast the long poll it is carrying', async () => {
    // A 15s transport timeout would abort every 30s long poll before Telegram
    // ever answered, turning the poller into a hot reconnect loop.
    await makeClient().getUpdates(undefined, 30);

    expect(get.mock.calls[0][1].timeout).toBeGreaterThan(30_000);
  });

  it('returns an empty list when Telegram had nothing to hand over', async () => {
    get.mockResolvedValue({ data: { ok: true, result: [] } });

    expect(await makeClient().getUpdates(1, 30)).toEqual([]);
  });

  it('returns an empty list rather than undefined when the result is missing', async () => {
    get.mockResolvedValue({ data: { ok: true } });

    expect(await makeClient().getUpdates(1, 30)).toEqual([]);
  });

  it('never puts the bot token in the error it throws', async () => {
    get.mockRejectedValue(
      new Error(`Request failed: https://api.telegram.org/bot${TOKEN}/getUpdates`),
    );

    await expect(makeClient().getUpdates(1, 30)).rejects.not.toThrow(/AAHsecret/);
  });
});
