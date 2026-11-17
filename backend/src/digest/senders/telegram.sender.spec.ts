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

  it('sends no parse_mode, so teacher free text cannot break the message', async () => {
    // Telegram rejects a whole message whose text has unbalanced markup, and
    // remarks routinely contain * _ - . and !
    await makeSender().send('chat-1', 'להגיש עד 5.11 — *חשוב*');

    expect(post.mock.calls[0][1].parse_mode).toBeUndefined();
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

  it('refuses to send when no bot token is configured', async () => {
    await expect(makeSender({ TELEGRAM_BOT_TOKEN: '' }).send('chat-1', 'שלום')).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
