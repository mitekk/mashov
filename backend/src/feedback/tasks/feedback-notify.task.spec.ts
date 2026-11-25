import type { FeedbackNotifierService } from '../feedback-notifier.service';
import { FeedbackNotifyTask } from './feedback-notify.task';

function build(configured = false) {
  const deliverPending = jest.fn().mockResolvedValue([]);
  // The task asks the notifier whether there is a destination rather than
  // reading env vars itself, so the var names live in one place. What is
  // asserted here is the delegation and the silence, not the rule.
  const isConfigured = jest.fn().mockReturnValue(configured);
  const notifier = { deliverPending, isConfigured } as unknown as FeedbackNotifierService;

  const task = new FeedbackNotifyTask(notifier);
  const logger = (task as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  return { task, deliverPending, isConfigured, log, error };
}

describe('FeedbackNotifyTask', () => {
  it('does nothing at all when there is nowhere to deliver to', async () => {
    const { task, deliverPending, log, error } = build(false);

    await task.run();

    expect(deliverPending).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('asks the notifier before touching the database', async () => {
    // Order matters: the gate exists so an unconfigured stack runs no query on
    // any of its 720 ticks a day.
    const { task, isConfigured, deliverPending } = build(false);

    await task.run();

    expect(isConfigured).toHaveBeenCalledTimes(1);
    expect(deliverPending).not.toHaveBeenCalled();
  });

  it('stays silent on a tick that found nothing to deliver', async () => {
    const { task, deliverPending, log } = build(true);

    await task.run();

    expect(deliverPending).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('reduces the run to one counted summary line', async () => {
    const { task, deliverPending, log } = build(true);
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
    const { task, deliverPending, error } = build(true);
    deliverPending.mockRejectedValue(new Error('db gone'));

    // A rejection out of a cron callback is an unhandled rejection, which Node
    // treats as fatal by default.
    await expect(task.run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db gone'));
  });
});
