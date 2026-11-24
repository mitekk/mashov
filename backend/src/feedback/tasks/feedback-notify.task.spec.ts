import { ConfigService } from '@nestjs/config';
import type { FeedbackNotifierService } from '../feedback-notifier.service';
import { FeedbackNotifyTask } from './feedback-notify.task';

function build(chatId?: string) {
  const deliverPending = jest.fn().mockResolvedValue([]);
  const notifier = { deliverPending } as unknown as FeedbackNotifierService;
  const config = {
    get: (key: string) => (key === 'FEEDBACK_TELEGRAM_CHAT_ID' ? chatId : undefined),
  } as unknown as ConfigService;

  const task = new FeedbackNotifyTask(notifier, config);
  const logger = (task as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  return { task, deliverPending, log, error };
}

describe('FeedbackNotifyTask', () => {
  it('does nothing at all when no chat id is configured', async () => {
    const { task, deliverPending, log, error } = build();

    await task.run();

    expect(deliverPending).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('treats a blank chat id as unset', async () => {
    const { task, deliverPending } = build('  ');
    await task.run();
    expect(deliverPending).not.toHaveBeenCalled();
  });

  it('stays silent on a tick that found nothing to deliver', async () => {
    const { task, deliverPending, log } = build('-100123');

    await task.run();

    expect(deliverPending).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('reduces the run to one counted summary line', async () => {
    const { task, deliverPending, log } = build('-100123');
    deliverPending.mockResolvedValue([
      { id: 'a', status: 'sent' },
      { id: 'b', status: 'sent' },
      { id: 'c', status: 'retired' },
    ]);

    await task.run();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('sent=2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retired=1'));
  });

  it('swallows a rejection rather than letting it kill the process', async () => {
    const { task, deliverPending, error } = build('-100123');
    deliverPending.mockRejectedValue(new Error('db gone'));

    // A rejection out of a cron callback is an unhandled rejection, which Node
    // treats as fatal by default.
    await expect(task.run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db gone'));
  });
});
