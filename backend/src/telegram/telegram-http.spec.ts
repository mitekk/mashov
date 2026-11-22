import axios, { AxiosInstance } from 'axios';
import {
  TELEGRAM_API_ROOT,
  TELEGRAM_CHUNK_LIMIT,
  botPath,
  chunkTelegramText,
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

  it('names the transport failure when the request never got a response', () => {
    // A long poll that times out, or a DNS failure, has no response at all.
    // "HTTP unknown" is the one string in here a parent can actually be shown
    // (it reaches confirmationError and then step 4), and it told them nothing
    // while axios had the reason in error.code the whole time.
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    expect(
      describeTelegramError({ code: 'ECONNABORTED', message: 'timeout of 45000ms exceeded' }),
    ).toBe('ECONNABORTED: timeout of 45000ms exceeded');
  });

  it('falls back to the message alone when there is no code either', () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    expect(describeTelegramError({ message: 'socket hang up' })).toBe('socket hang up');
  });

  it('still says something when an axios error carries neither', () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    expect(describeTelegramError({})).toBe('request failed');
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

/** A high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('chunkTelegramText', () => {
  it('returns a short message unchanged as a single part', () => {
    expect(chunkTelegramText('שלום')).toEqual(['שלום']);
  });

  it('defaults to a limit below the Bot API ceiling of 4096 code units', () => {
    expect(TELEGRAM_CHUNK_LIMIT).toBeLessThan(4096);
  });

  it('keeps every part inside the limit', () => {
    const parts = chunkTelegramText('x'.repeat(10_000), 1000);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1000);
  });

  it('splits on the last blank line before the limit, so a section stays whole', () => {
    const text = ['כותרת\nראשון', 'שני', 'שלישי'].join('\n\n');

    // 20 is past "כותרת\nראשון\n\nשני" (18) and short of the next separator.
    expect(chunkTelegramText(text, 20)).toEqual(['כותרת\nראשון\n\nשני', 'שלישי']);
  });

  it('falls back to the last single newline when no blank line fits', () => {
    const text = 'אחת\nשתיים\nשלוש';

    expect(chunkTelegramText(text, 11)).toEqual(['אחת\nשתיים', 'שלוש']);
  });

  it('hard-cuts text that carries no newline at all', () => {
    expect(chunkTelegramText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('never cuts between the halves of a surrogate pair', () => {
    // '😀' is two UTF-16 code units, which is what Telegram counts. A cut at
    // an odd offset would emit a lone surrogate and render as a replacement
    // character in the parent's chat.
    const parts = chunkTelegramText('😀😀😀', 3);

    expect(parts).toEqual(['😀', '😀', '😀']);
    for (const part of parts) expect(part).not.toMatch(LONE_SURROGATE);
  });

  it('emits no empty part when the split point lands on a run of newlines', () => {
    const parts = chunkTelegramText('אחת\n\n\n\nשתיים\n\n\n\nשלוש', 12);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.trim().length).toBeGreaterThan(0);
  });

  it('loses no visible content across the parts', () => {
    const text = Array.from({ length: 400 }, (_, i) => `שורה ${i}`).join('\n');

    const rejoined = chunkTelegramText(text, 500).join('\n');

    expect(rejoined).toBe(text);
  });
});
