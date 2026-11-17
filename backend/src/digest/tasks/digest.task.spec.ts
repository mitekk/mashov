import { DigestTask } from './digest.task';
import type { DigestService } from '../digest.service';
import type { DigestRetentionService } from '../digest-retention.service';
import type { ConfigService } from '@nestjs/config';

function makeTask(env: Record<string, string> = {}) {
  const runAll = jest.fn().mockResolvedValue([
    { studentGuid: 'stu-1', status: 'sent', itemCount: 2, recipientCount: 1, usedLlm: true },
  ]);
  const config = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;

  const prune = jest.fn().mockResolvedValue({ reportedItems: 0, deliveries: 0 });
  const task = new DigestTask(
    { runAll } as unknown as DigestService,
    { prune } as unknown as DigestRetentionService,
    config,
  );

  return { runAll, prune, task };
}

describe('DigestTask', () => {
  it('does nothing when DIGEST_ENABLED is unset', async () => {
    // Defaults to off: the cron stays dormant until deliberately enabled.
    const { task, runAll } = makeTask();

    await task.run();

    expect(runAll).not.toHaveBeenCalled();
  });

  it('does nothing when DIGEST_ENABLED is false', async () => {
    const { task, runAll } = makeTask({ DIGEST_ENABLED: 'false' });

    await task.run();

    expect(runAll).not.toHaveBeenCalled();
  });

  it('runs when DIGEST_ENABLED is true', async () => {
    const { task, runAll } = makeTask({ DIGEST_ENABLED: 'true' });

    await task.run();

    expect(runAll).toHaveBeenCalledTimes(1);
  });

  it('fires hourly from 13:00 to 19:00 in Asia/Jerusalem', () => {
    // No other cron in this repo sets timeZone, and the process zone is pinned to
    // UTC (backend/Dockerfile, src/common/process-zone.ts), so without an explicit
    // timeZone the job would run 10:00-16:00 Israel time in winter and drift with
    // DST. The pin does not substitute for it -- it is what makes it necessary.
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', DigestTask.prototype.run);

    expect(options).toMatchObject({ timeZone: 'Asia/Jerusalem' });
  });

  it('is scheduled on the hour across the afternoon window', () => {
    const metadata = Reflect.getMetadataKeys(DigestTask.prototype.run)
      .map((key) => ({ key, value: Reflect.getMetadata(key, DigestTask.prototype.run) }))
      .find((entry) => typeof entry.value === 'object' && entry.value !== null && 'cronTime' in entry.value);

    expect(metadata?.value).toMatchObject({ cronTime: '0 13-19 * * *' });
  });

  it('prunes history even when the digest itself is disabled', () => {
    // Rows written while the feature was on must still age out after it is
    // turned off.
    const { task, prune } = makeTask();

    return task.pruneHistory().then(() => {
      expect(prune).toHaveBeenCalledTimes(1);
    });
  });
});
