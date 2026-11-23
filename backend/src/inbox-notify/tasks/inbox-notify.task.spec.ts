import { InboxNotifyTask } from './inbox-notify.task';
import type { InboxNotifyService } from '../inbox-notify.service';
import type { ConfigService } from '@nestjs/config';

function makeTask(env: Record<string, string> = {}) {
  const notifyAll = jest.fn().mockResolvedValue([
    { userId: 'user-a', channel: 'telegram', address: '1', status: 'sent', messageCount: 1, summarized: false },
  ]);
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
  const task = new InboxNotifyTask({ notifyAll } as unknown as InboxNotifyService, config);

  return { notifyAll, task };
}

describe('InboxNotifyTask', () => {
  it('does nothing when INBOX_NOTIFY_ENABLED is unset', async () => {
    const { task, notifyAll } = makeTask();

    await task.run();

    expect(notifyAll).not.toHaveBeenCalled();
  });

  it('does nothing when INBOX_NOTIFY_ENABLED is false', async () => {
    const { task, notifyAll } = makeTask({ INBOX_NOTIFY_ENABLED: 'false' });

    await task.run();

    expect(notifyAll).not.toHaveBeenCalled();
  });

  it('runs when INBOX_NOTIFY_ENABLED is true', async () => {
    const { task, notifyAll } = makeTask({ INBOX_NOTIFY_ENABLED: 'true' });

    await task.run();

    expect(notifyAll).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure rather than taking the process down', async () => {
    // An unhandled rejection out of a cron callback is fatal to Node by
    // default. One database blip must not kill the app.
    const { task, notifyAll } = makeTask({ INBOX_NOTIFY_ENABLED: 'true' });
    notifyAll.mockRejectedValue(new Error('connection pool timeout'));

    await expect(task.run()).resolves.toBeUndefined();
  });

  it('fires every ten minutes in Asia/Jerusalem', () => {
    // The zone is load-bearing even though the expression is zone-independent:
    // the quiet-hours check inside the handler reads the same zone, and the
    // process is pinned to UTC.
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', InboxNotifyTask.prototype.run);

    expect(options).toMatchObject({ timeZone: 'Asia/Jerusalem' });
  });

  it('is scheduled on a ten-minute cadence', () => {
    const metadata = Reflect.getMetadataKeys(InboxNotifyTask.prototype.run)
      .map((key) => ({ key, value: Reflect.getMetadata(key, InboxNotifyTask.prototype.run) }))
      .find(
        (entry) =>
          typeof entry.value === 'object' && entry.value !== null && 'cronTime' in entry.value,
      );

    expect(metadata?.value).toMatchObject({ cronTime: '*/10 * * * *' });
  });
});
