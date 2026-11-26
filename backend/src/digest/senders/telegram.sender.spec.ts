import axios, { AxiosInstance } from 'axios';
import { TelegramSender } from './telegram.sender';
import type { ConfigService } from '@nestjs/config';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const TOKEN = '123456:AAHsecretvaluethatmustneverleak';

function makeSender(env: Record<string, string> = {}) {
  const config = {
    get: jest.fn((key: string) => ({ TELEGRAM_BOT_TOKEN: TOKEN, ...env })[key]),
  } as unknown as ConfigService;
  return new TelegramSender(config);
}

describe('TelegramSender', () => {
  let post: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    post = jest.fn().mockResolvedValue({ data: { ok: true, result: { message_id: 7 } } });
    mockedAxios.create.mockReturnValue({ post } as unknown as AxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  });

  it('identifies itself as the telegram channel', () => {
    expect(makeSender().channel).toBe('telegram');
  });

  it('posts the message text to the chat', async () => {
    await makeSender().send('chat-1', 'שלום');

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0];
    expect(path).toContain('sendMessage');
    expect(body.chat_id).toBe('chat-1');
    expect(body.text).toBe('שלום');
  });

  it('sends no parse_mode for a caller that did not say its text was HTML', async () => {
    // The default is still flat. Only a caller that rendered HTML asks for it,
    // which keeps every other send path exactly as safe as it was.
    await makeSender().send('chat-1', 'להגיש עד 5.11 — *חשוב*');

    expect(post.mock.calls[0][1].parse_mode).toBeUndefined();
  });

  it('sends parse_mode HTML when the caller rendered HTML', async () => {
    // The reversal of the old "no parse_mode ever" rule. HTML reserves three
    // characters -- & < > -- none of which appears in ordinary Hebrew, so the
    // escape boundary is one a template can actually hold. See ADR-0047.
    await makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' });

    expect(post.mock.calls[0][1].parse_mode).toBe('HTML');
    expect(post.mock.calls[0][1].text).toBe('<b>כותרת</b>');
  });

  it('sends the markup through untouched, because escaping is the template\'s boundary', async () => {
    // The sender must not double-escape: the template already ran
    // escapeTelegramHtml over every interpolated value, and a second pass here
    // would show the parent &lt;b&gt; where it rendered a tag.
    await makeSender().send('chat-1', '<b>ציון</b>: 90 &amp; עולה', { parseMode: 'HTML' });

    expect(post.mock.calls[0][1].text).toBe('<b>ציון</b>: 90 &amp; עולה');
  });

  it('retries the same message as plain text when Telegram cannot parse the markup', async () => {
    // A parse failure must never cost a parent the whole message. The retry is
    // the belt the no-parse-mode rule used to be.
    post.mockResolvedValueOnce({
      data: { ok: false, description: "Bad Request: can't parse entities: Unclosed start tag" },
    });

    await makeSender().send('chat-1', '<b>כותרת</b>\nהערה & עוד', { parseMode: 'HTML' });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].parse_mode).toBeUndefined();
    expect(post.mock.calls[1][1].text).toBe('כותרת\nהערה & עוד');
  });

  it('treats a parse-failure retry that succeeds as a delivered message, not a failure', async () => {
    // It must not throw: a throw releases the digest's claims, and the parent
    // already has the text.
    post.mockResolvedValueOnce({
      data: { ok: false, description: 'Bad Request: unsupported start tag "3"' },
    });

    await expect(
      makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' }),
    ).resolves.toBeUndefined();
  });

  it('retries only once, and reports the retry\'s own refusal', async () => {
    post.mockResolvedValue({
      data: { ok: false, description: "Bad Request: can't parse entities: Unclosed start tag" },
    });

    await expect(
      makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' }),
    ).rejects.toThrow(/parse entities/);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refusal that is not about the markup', async () => {
    // Retrying a 429 or a blocked bot as plain text would report success for a
    // message that never arrived, and the digest would confirm its claims.
    post.mockResolvedValue({ data: { ok: false, description: 'Too Many Requests: retry after 30' } });

    await expect(
      makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' }),
    ).rejects.toThrow(/Too Many Requests/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not retry a transport failure as plain text', async () => {
    post.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    await expect(
      makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' }),
    ).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends the message flat when TELEGRAM_HTML_ENABLED is off', async () => {
    // The kill switch is a restart rather than a deploy: templates always emit
    // HTML, and the sender is the one thing that decides whether it goes out
    // as HTML or stripped.
    await makeSender({ TELEGRAM_HTML_ENABLED: 'false' }).send(
      'chat-1',
      '<b>כותרת</b>\n<blockquote>הערה &amp; עוד</blockquote>',
      { parseMode: 'HTML' },
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].parse_mode).toBeUndefined();
    expect(post.mock.calls[0][1].text).toBe('כותרת\nהערה & עוד');
  });

  it('sends HTML when TELEGRAM_HTML_ENABLED is unset, so the default is on', async () => {
    await makeSender().send('chat-1', '<b>כותרת</b>', { parseMode: 'HTML' });

    expect(post.mock.calls[0][1].parse_mode).toBe('HTML');
  });

  it('chunks the stripped text, not the markup, when HTML is off', async () => {
    // Chunking the markup and stripping afterwards would produce parts cut to
    // a budget the sent text no longer has.
    const text = Array.from({ length: 900 }, (_, i) => `<b>שורה ${i}</b>`).join('\n');

    await makeSender({ TELEGRAM_HTML_ENABLED: '0' }).send('chat-1', text, { parseMode: 'HTML' });

    for (const [, body] of post.mock.calls) {
      expect(String(body.text)).not.toContain('<b>');
      expect(String(body.text).length).toBeLessThanOrEqual(4000);
    }
  });

  it('bypasses the Mashov residential egress proxy explicitly', async () => {
    // HTTPS_PROXY is process-wide and plain axios honours it. ADR-0023's hop is
    // a single residential tinyproxy with a 10s abort and no retry; a parent's
    // message must never traverse it.
    makeSender();

    expect((mockedAxios.create as jest.Mock).mock.calls[0][0].proxy).toBe(false);
  });

  it('keeps the bot token out of the axios base URL', async () => {
    // An axios error carries config.url, which reaches logs and error trackers.
    makeSender();

    const baseURL = (mockedAxios.create as jest.Mock).mock.calls[0][0].baseURL ?? '';
    expect(baseURL).not.toContain(TOKEN);
  });

  it('never puts the bot token in the error it throws', async () => {
    post.mockRejectedValue(
      Object.assign(new Error(`Request failed: https://api.telegram.org/bot${TOKEN}/sendMessage`), {
        response: { status: 400, data: { description: 'chat not found' } },
        config: { url: `/bot${TOKEN}/sendMessage` },
      }),
    );

    await expect(makeSender().send('chat-1', 'שלום')).rejects.toThrow(/chat not found/);
    await expect(makeSender().send('chat-1', 'שלום')).rejects.not.toThrow(/AAHsecret/);
  });

  it('throws when Telegram reports the send was not ok', async () => {
    post.mockResolvedValue({ data: { ok: false, description: 'bot was blocked by the user' } });

    await expect(makeSender().send('chat-1', 'שלום')).rejects.toThrow(/blocked/);
  });

  it('disables the link preview, so a link line cannot grow a card in the chat', async () => {
    await makeSender().send('chat-1', 'שלום');

    expect(post.mock.calls[0][1].disable_web_page_preview).toBe(true);
  });

  it('splits a message past the Bot API limit into sequential parts', async () => {
    // An over-long message used to fail outright: deliver() threw, the claims
    // were released, and the next hourly run built the same message and failed
    // the same way forever.
    const text = Array.from({ length: 900 }, (_, i) => `שורה מספר ${i}`).join('\n');
    expect(text.length).toBeGreaterThan(4096);

    await makeSender().send('chat-1', text);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    for (const [, body] of post.mock.calls) {
      expect(body.chat_id).toBe('chat-1');
      expect(String(body.text).length).toBeLessThanOrEqual(4096);
      expect(body.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('sends parse_mode HTML and no link preview on every part of a split message', async () => {
    // Every part has to carry the parse mode: a part sent flat would show the
    // parent raw tags in the middle of a message whose first half rendered.
    const text = Array.from({ length: 900 }, (_, i) => `<b>שורה</b> להגיש עד 5.11 ${i}`).join('\n');

    await makeSender().send('chat-1', text, { parseMode: 'HTML' });

    expect(post.mock.calls.length).toBeGreaterThan(1);
    for (const [, body] of post.mock.calls) {
      expect(body.parse_mode).toBe('HTML');
      expect(body.disable_web_page_preview).toBe(true);
    }
  });

  it('retries only the part Telegram could not parse, flat', async () => {
    const text = Array.from({ length: 900 }, (_, i) => `<b>שורה</b> ${i}`).join('\n');
    post.mockResolvedValueOnce({ data: { ok: true } });
    post.mockResolvedValueOnce({
      data: { ok: false, description: "Bad Request: can't parse entities" },
    });

    await makeSender().send('chat-1', text, { parseMode: 'HTML' });

    const flat = post.mock.calls.filter(([, body]) => body.parse_mode === undefined);
    expect(flat).toHaveLength(1);
    expect(String(flat[0][1].text)).not.toContain('<b>');
  });

  it('sends no parse_mode on any part of a split message a caller did not mark as HTML', async () => {
    const text = Array.from({ length: 900 }, (_, i) => `להגיש עד 5.11 — *חשוב* ${i}`).join('\n');

    await makeSender().send('chat-1', text);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    for (const [, body] of post.mock.calls) {
      expect(body.parse_mode).toBeUndefined();
      expect(body.disable_web_page_preview).toBe(true);
    }
  });

  it('stops at the part Telegram refused rather than sending the rest', async () => {
    const text = Array.from({ length: 900 }, (_, i) => `שורה מספר ${i}`).join('\n');
    post.mockResolvedValueOnce({ data: { ok: true } });
    post.mockResolvedValueOnce({ data: { ok: false, description: 'chat not found' } });

    await expect(makeSender().send('chat-1', text)).rejects.toThrow(/chat not found/);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('refuses to send when no bot token is configured', async () => {
    await expect(makeSender({ TELEGRAM_BOT_TOKEN: '' }).send('chat-1', 'שלום')).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
