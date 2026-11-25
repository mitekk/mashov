import { ConfigService } from '@nestjs/config';
import { FeedbackTelegramSender } from './feedback-telegram.sender';
import { TelegramSender } from '../digest/senders/telegram.sender';
import { createTelegramHttp } from '../telegram/telegram-http';

jest.mock('../telegram/telegram-http', () => {
  const actual = jest.requireActual('../telegram/telegram-http');
  return { ...actual, createTelegramHttp: jest.fn() };
});

const FEEDBACK_TOKEN = '777:feedback-bot-token';
const PARENT_TOKEN = '111:parent-bot-token';

function makeSender(env: Record<string, string | undefined> = {}) {
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          FEEDBACK_TELEGRAM_BOT_TOKEN: FEEDBACK_TOKEN,
          TELEGRAM_BOT_TOKEN: PARENT_TOKEN,
          ...env,
        })[key],
    ),
  } as unknown as ConfigService;
  return new FeedbackTelegramSender(config);
}

describe('FeedbackTelegramSender', () => {
  let post: jest.Mock;

  beforeEach(() => {
    post = jest.fn().mockResolvedValue({ data: { ok: true } });
    (createTelegramHttp as jest.Mock).mockReturnValue({ post });
  });

  it('is a TelegramSender, so the chunking and redaction are not re-implemented', () => {
    expect(makeSender()).toBeInstanceOf(TelegramSender);
  });

  it('sends with the feedback bot token, never the parent-facing one', async () => {
    await makeSender().send('-1001234567890', 'New feedback report');

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0];
    expect(path).toContain(FEEDBACK_TOKEN);
    expect(path).not.toContain(PARENT_TOKEN);
    expect(body).toMatchObject({ chat_id: '-1001234567890', text: 'New feedback report' });
  });

  it('refuses to send when only the parent bot token is configured', async () => {
    // The whole point of the split: a missing feedback token must not quietly
    // fall back to the bot parents talk to.
    const sender = makeSender({ FEEDBACK_TELEGRAM_BOT_TOKEN: undefined });

    await expect(sender.send('-100', 'hi')).rejects.toThrow(/FEEDBACK_TELEGRAM_BOT_TOKEN/);
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a blank token as unset', async () => {
    const sender = makeSender({ FEEDBACK_TELEGRAM_BOT_TOKEN: '   ' });

    await expect(sender.send('-100', 'hi')).rejects.toThrow(/FEEDBACK_TELEGRAM_BOT_TOKEN/);
    expect(post).not.toHaveBeenCalled();
  });

  it('reports whether a token is configured, so the outbox can gate on it', () => {
    expect(makeSender().hasToken()).toBe(true);
    expect(makeSender({ FEEDBACK_TELEGRAM_BOT_TOKEN: '' }).hasToken()).toBe(false);
    expect(makeSender({ FEEDBACK_TELEGRAM_BOT_TOKEN: '  ' }).hasToken()).toBe(false);
  });

  it('never names the token value in the error it throws', async () => {
    post.mockRejectedValue(new Error(`Request failed: /bot${FEEDBACK_TOKEN}/sendMessage`));

    await expect(makeSender().send('-100', 'hi')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(FEEDBACK_TOKEN) }),
    );
  });
});
