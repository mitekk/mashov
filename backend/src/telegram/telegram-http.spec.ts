import axios, { AxiosInstance } from 'axios';
import {
  TELEGRAM_API_ROOT,
  botPath,
  createTelegramHttp,
  describeTelegramError,
  redact,
} from './telegram-http';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const TOKEN = '123456:AAHsecretvaluethatmustneverleak';

describe('createTelegramHttp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create.mockReturnValue({} as unknown as AxiosInstance);
  });

  it('bypasses the Mashov residential egress proxy explicitly', () => {
    // HTTPS_PROXY is process-wide and plain axios honours it. ADR-0023's hop is
    // a single residential tinyproxy with a 10s abort and no retry, meant only
    // for Mashov -- a parent's traffic must never traverse it. One place owns
    // this decision so a second Telegram caller cannot forget it.
    createTelegramHttp();

    expect((mockedAxios.create as jest.Mock).mock.calls[0][0].proxy).toBe(false);
  });

  it('keeps the bot token out of the axios base URL', () => {
    // An axios error carries config.url, which reaches logs and error trackers.
    createTelegramHttp();

    expect((mockedAxios.create as jest.Mock).mock.calls[0][0].baseURL).toBe(TELEGRAM_API_ROOT);
  });

  it('accepts a longer timeout than the default for long-polling callers', () => {
    createTelegramHttp({ timeoutMs: 95_000 });

    expect((mockedAxios.create as jest.Mock).mock.calls[0][0].timeout).toBe(95_000);
  });
});

describe('botPath', () => {
  it('puts the token on the request path rather than the base URL', () => {
    expect(botPath(TOKEN, 'sendMessage')).toBe(`/bot${TOKEN}/sendMessage`);
  });

  it('trims a token that arrived with surrounding whitespace from .env', () => {
    expect(botPath(`  ${TOKEN}\n`, 'getMe')).toBe(`/bot${TOKEN}/getMe`);
  });
});

describe('redact', () => {
  it('removes every occurrence of the token from text bound for a log', () => {
    const text = `GET /bot${TOKEN}/getUpdates failed, retrying /bot${TOKEN}/getUpdates`;

    const redacted = redact(text, TOKEN);

    expect(redacted).not.toContain('AAHsecret');
    expect(redacted).toContain('[redacted]');
  });

  it('leaves text alone when there is no token to redact', () => {
    expect(redact('chat not found', '')).toBe('chat not found');
  });
});

describe('describeTelegramError', () => {
  it("prefers Telegram's own description over the HTTP status", () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    const described = describeTelegramError({
      response: { status: 400, data: { description: 'chat not found' } },
    });

    expect(described).toBe('chat not found');
  });

  it('falls back to the status when Telegram sent no description', () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    expect(describeTelegramError({ response: { status: 502, data: {} } })).toBe('HTTP 502');
  });

  it('describes a non-axios failure by its message', () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);

    expect(describeTelegramError(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('stringifies a thrown value that is not an Error at all', () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);

    expect(describeTelegramError('nope')).toBe('nope');
  });
});
