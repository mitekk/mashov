import axios, { AxiosInstance } from 'axios';
import FormData = require('form-data');
import { TelegramMediaSender, safeFileName, truncateCaption } from './telegram-media.sender';
import type { ConfigService } from '@nestjs/config';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const TOKEN = '123456:AAHsecretvaluethatmustneverleak';

function makeSender(env: Record<string, string> = {}) {
  const config = {
    get: jest.fn((key: string) => ({ TELEGRAM_BOT_TOKEN: TOKEN, ...env })[key]),
  } as unknown as ConfigService;
  return new TelegramMediaSender(config);
}

function pdf(overrides: Record<string, unknown> = {}) {
  return {
    fileName: 'אישור הורים.pdf',
    buffer: Buffer.from('%PDF-1.4 pretend'),
    contentType: 'application/pdf',
    ...overrides,
  };
}

/** The multipart body as text. Every part here is a string or a Buffer. */
function bodyOf(post: jest.Mock, call = 0): string {
  return (post.mock.calls[call][1] as FormData).getBuffer().toString('latin1');
}

describe('TelegramMediaSender', () => {
  let post: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    post = jest.fn().mockResolvedValue({ data: { ok: true, result: { message_id: 7 } } });
    mockedAxios.create.mockReturnValue({ post } as unknown as AxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  });

  it('uploads a pdf with sendDocument', async () => {
    await makeSender().sendMedia('chat-1', pdf());

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain('sendDocument');
    const body = bodyOf(post);
    expect(body).toContain('name="chat_id"');
    expect(body).toContain('chat-1');
    expect(body).toContain('name="document"');
  });

  it('uploads a jpeg with sendPhoto, under the photo field', async () => {
    await makeSender().sendMedia('chat-1', pdf({ fileName: 'a.jpg', contentType: 'image/jpeg' }));

    expect(post.mock.calls[0][0]).toContain('sendPhoto');
    expect(bodyOf(post)).toContain('name="photo"');
  });

  it('sends the caption, and no parse_mode for a caller that did not render HTML', async () => {
    await makeSender().sendMedia('chat-1', pdf({ caption: 'אישור הורים.pdf — טיול שנתי' }));

    const body = bodyOf(post);
    expect(body).toContain('name="caption"');
    expect(body).not.toContain('parse_mode');
  });

  it('sends parse_mode HTML for a caption the caller rendered as HTML', async () => {
    // The caption now anchors a deep link to the item the file came from, so
    // it has to be parsed. See ADR-0047.
    await makeSender().sendMedia(
      'chat-1',
      pdf({
        caption: '📎 <a href="https://x/children/g/homework/1">דף 42</a>',
        captionParseMode: 'HTML',
      }),
    );

    const body = bodyOf(post);
    expect(body).toContain('name="parse_mode"');
    expect(body).toContain('HTML');
  });

  it('retries the upload with a flat caption when Telegram cannot parse it', async () => {
    // One unparseable caption must not cost the parent the file.
    post.mockResolvedValueOnce({
      data: { ok: false, description: "Bad Request: can't parse entities: Unclosed start tag" },
    });

    await makeSender().sendMedia(
      'chat-1',
      pdf({ caption: '📎 <a href="https://x/a">דף 42</a> &amp; עוד', captionParseMode: 'HTML' }),
    );

    expect(post).toHaveBeenCalledTimes(2);
    const retried = bodyOf(post, 1);
    expect(retried).not.toContain('name="parse_mode"');
    expect(retried).toContain('&');
    expect(retried).not.toContain('<a href');
  });

  it('does not retry an upload Telegram refused for a reason other than the markup', async () => {
    post.mockResolvedValue({ data: { ok: false, description: 'Bad Request: chat not found' } });

    await expect(
      makeSender().sendMedia('chat-1', pdf({ caption: '<b>x</b>', captionParseMode: 'HTML' })),
    ).rejects.toThrow(/chat not found/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends a flat caption when TELEGRAM_HTML_ENABLED is off', async () => {
    await makeSender({ TELEGRAM_HTML_ENABLED: 'false' }).sendMedia(
      'chat-1',
      pdf({ caption: '📎 <a href="https://x/a">דף 42</a>', captionParseMode: 'HTML' }),
    );

    expect(post).toHaveBeenCalledTimes(1);
    const body = bodyOf(post);
    expect(body).not.toContain('name="parse_mode"');
    expect(body).not.toContain('<a href');
  });

  it('truncates a caption past the Bot API limit, since a caption cannot be chunked', async () => {
    await makeSender().sendMedia('chat-1', pdf({ caption: 'א'.repeat(2000) }));

    const body = (post.mock.calls[0][1] as FormData).getBuffer().toString('utf8');
    const caption = body.split('name="caption"')[1].split('\r\n\r\n')[1].split('\r\n')[0];
    expect(caption).toHaveLength(1001);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('sends no caption field at all when there is nothing to caption', async () => {
    await makeSender().sendMedia('chat-1', pdf());

    expect(bodyOf(post)).not.toContain('name="caption"');
  });

  it('sanitizes a filename that carries path separators or control characters', async () => {
    await makeSender().sendMedia(
      'chat-1',
      pdf({ fileName: '../../etc/pass\u0000wd\nx.pdf' }),
    );

    const body = bodyOf(post);
    expect(body).not.toContain('../');
    expect(body).not.toContain('\u0000');
  });

  it('keeps a readable name for a file whose name was entirely unusable', async () => {
    await makeSender().sendMedia('chat-1', pdf({ fileName: '///' }));

    expect(bodyOf(post)).toMatch(/filename="[^"]+"/);
  });

  it('refuses an oversize file without making a single HTTP call', async () => {
    // Checked before the upload, not after Telegram rejects it: the point is
    // not to push 30 MB across the wire to be told no.
    const huge = pdf({ buffer: Buffer.alloc(1024) });

    await expect(
      makeSender({ TELEGRAM_MEDIA_MAX_BYTES: '512' }).sendMedia('chat-1', huge),
    ).rejects.toThrow(/too large/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('lets axios carry a body larger than its own default ceiling', async () => {
    makeSender();

    const created = (mockedAxios.create as jest.Mock).mock.calls[0][0];
    expect(created.maxBodyLength).toBe(Infinity);
    expect(created.maxContentLength).toBe(Infinity);
  });

  it('bypasses the Mashov residential egress proxy explicitly', async () => {
    makeSender();

    expect((mockedAxios.create as jest.Mock).mock.calls[0][0].proxy).toBe(false);
  });

  it('keeps the bot token out of the axios base URL', async () => {
    makeSender();

    const baseURL = (mockedAxios.create as jest.Mock).mock.calls[0][0].baseURL ?? '';
    expect(baseURL).not.toContain(TOKEN);
  });

  it('never puts the bot token in the error it throws', async () => {
    post.mockRejectedValue(
      Object.assign(new Error(`Request failed: https://api.telegram.org/bot${TOKEN}/sendDocument`), {
        response: { status: 400, data: { description: 'chat not found' } },
        config: { url: `/bot${TOKEN}/sendDocument` },
      }),
    );

    await expect(makeSender().sendMedia('chat-1', pdf())).rejects.toThrow(/chat not found/);
    await expect(makeSender().sendMedia('chat-1', pdf())).rejects.not.toThrow(/AAHsecret/);
  });

  it('throws when Telegram reports the upload was not ok', async () => {
    post.mockResolvedValue({ data: { ok: false, description: 'file is too big' } });

    await expect(makeSender().sendMedia('chat-1', pdf())).rejects.toThrow(/too big/);
  });

  it('refuses to upload when no bot token is configured', async () => {
    await expect(
      makeSender({ TELEGRAM_BOT_TOKEN: '' }).sendMedia('chat-1', pdf()),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses an empty file rather than uploading nothing', async () => {
    await expect(
      makeSender().sendMedia('chat-1', pdf({ buffer: Buffer.alloc(0) })),
    ).rejects.toThrow(/empty/i);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('truncateCaption', () => {
  it('leaves a caption inside the limit exactly as it was', () => {
    expect(truncateCaption('אישור.pdf — טיול')).toBe('אישור.pdf — טיול');
  });

  it('cuts below the 1024 ceiling and marks the cut', () => {
    const cut = truncateCaption('א'.repeat(5000));

    expect(cut).toHaveLength(1001);
    expect(cut?.endsWith('…')).toBe(true);
  });

  it.each([undefined, '', '   '])('returns undefined for %p, so no field is sent', (caption) => {
    expect(truncateCaption(caption)).toBeUndefined();
  });
});

describe('safeFileName', () => {
  it('keeps a Hebrew name, which is why form-data is used explicitly', () => {
    expect(safeFileName('אישור הורים.pdf')).toBe('אישור הורים.pdf');
  });

  it('keeps only the last path segment', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
  });

  it('drops control characters and quotes that would break the header', () => {
    expect(safeFileName('a\u0000"b.pdf')).toBe('ab.pdf');
  });

  it('caps a pathological length', () => {
    expect(safeFileName('x'.repeat(500))).toHaveLength(150);
  });

  it('always produces something to name the upload', () => {
    expect(safeFileName('///')).toBe('file');
    expect(safeFileName('   ')).toBe('file');
  });
});
