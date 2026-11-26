import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncService } from '../sync.service';
import { NotificationWindowTask } from './notification-window.task';
import { SYNC_STALE_AFTER_MS } from '../../digest/digest.service';
import { policyForSource } from '../source-policy';

/**
 * Read off the decorators in `notification-window.task.ts` and
 * `digest/tasks/digest.task.ts`. Changing either schedule without changing
 * these is what the first test below is here to catch.
 */
const DIGEST_LEAD_CRON = '50 10-18 * * *';
const DIGEST_SEND_CRON = '0 11-19 * * *';
const MAIL_WINDOW_CRON = '*/30 7-20 * * *';

describe('the digest-lead tick stays inside the digest staleness trip-wire', () => {
  /**
   * `digest.service.ts` reports a quiet child as `skipped_stale` rather than
   * `skipped_empty` when `homework`/`behavior` have no successful run inside
   * `SYNC_STALE_AFTER_MS`. That used to be guaranteed by 12-minute crons; it is
   * now guaranteed by the lead tick alone, and nothing else would fail if the
   * relationship broke.
   */
  it('fetches before every digest tick, by less than the trip-wire', () => {
    const lead = minutesOf(DIGEST_LEAD_CRON);
    const send = minutesOf(DIGEST_SEND_CRON);

    for (const sendAt of send) {
      // The newest lead tick at or before this send tick.
      const preceding = lead.filter((at) => at <= sendAt).pop();
      expect(preceding).toBeDefined();
      const ageMs = (sendAt - (preceding as number)) * 60_000;
      expect(ageMs).toBeLessThan(SYNC_STALE_AFTER_MS);
      // And it really is minutes, not hours.
      expect(ageMs).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it('covers the first digest tick of the day', () => {
    // A lead tick after 11:00 would leave the 11:00 send with yesterday's data
    // — more than six hours old, so `skipped_stale` for every quiet child.
    expect(Math.min(...minutesOf(DIGEST_LEAD_CRON))).toBeLessThan(
      Math.min(...minutesOf(DIGEST_SEND_CRON)),
    );
  });

  it('keeps the homework and behavior TTLs well inside the trip-wire', () => {
    // `respectTtl` means a lead tick may legitimately skip a source. The TTL is
    // therefore part of the bound: worst case is TTL + the gap between ticks.
    for (const source of ['homework', 'behavior']) {
      const ttlMs = (policyForSource(source)?.syncTtlMinutes ?? Infinity) * 60_000;
      expect(ttlMs + 60 * 60_000).toBeLessThan(SYNC_STALE_AFTER_MS);
    }
  });
});

describe('the mail window covers the inbox notifier', () => {
  it('runs through the notifier’s whole non-quiet window', () => {
    // `quiet-hours.ts` defaults to 21:00 -> 07:00, so the notifier is awake
    // 07:00-20:59. Hours where it is awake and nothing fetches are hours where
    // new mail is invisible to it.
    const hours = hoursOf(MAIL_WINDOW_CRON);
    expect(Math.min(...hours)).toBeLessThanOrEqual(7);
    expect(Math.max(...hours)).toBeGreaterThanOrEqual(20);
  });
});

describe('NotificationWindowTask', () => {
  let task: NotificationWindowTask;
  let refreshAll: jest.Mock;
  let digestRecipientFindMany: jest.Mock;
  let connectionFindMany: jest.Mock;
  let config: Record<string, string>;

  beforeEach(async () => {
    refreshAll = jest.fn().mockResolvedValue(undefined);
    digestRecipientFindMany = jest.fn().mockResolvedValue([{ userId: 'user-1' }]);
    connectionFindMany = jest.fn().mockResolvedValue([{ id: 'conn-1' }]);
    config = { DIGEST_ENABLED: 'true', INBOX_NOTIFY_ENABLED: 'true', NOTIFY_SYNC_JITTER_MS: '0' };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationWindowTask,
        {
          provide: PrismaService,
          useValue: {
            digestRecipient: { findMany: digestRecipientFindMany },
            householdConnection: { findMany: connectionFindMany },
          },
        },
        { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
        { provide: SyncService, useValue: { refreshAll } },
      ],
    }).compile();

    task = module.get(NotificationWindowTask);
  });

  it('does nothing at all when the digest is disabled', async () => {
    // The default posture: both flags ship false, so a default deployment does
    // zero background upstream work.
    config.DIGEST_ENABLED = 'false';

    await task.digestLead();

    expect(digestRecipientFindMany).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('does nothing when the inbox notifier is disabled', async () => {
    config.INBOX_NOTIFY_ENABLED = 'false';

    await task.mailWindow();

    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('syncs nothing when no household has notifications enabled', async () => {
    // The headline guarantee: opting out means zero background traffic.
    digestRecipientFindMany.mockResolvedValue([]);

    await task.digestLead();

    expect(connectionFindMany).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('selects only enabled recipients, and only their active connections', async () => {
    await task.digestLead();

    expect(digestRecipientFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true }, distinct: ['userId'] }),
    );
    expect(connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true, userId: { in: ['user-1'] } }),
      }),
    );
  });

  it('runs the roster and digest sets, TTL-gated and silent', async () => {
    await task.digestLead();

    expect(refreshAll).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      taskSet: 'roster',
      respectTtl: true,
      silent: true,
    });
    expect(refreshAll).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      taskSet: 'digest',
      respectTtl: true,
      silent: true,
    });
  });

  it('runs the mail set, TTL-gated and silent', async () => {
    await task.mailWindow();

    expect(refreshAll).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      taskSet: 'mail',
      respectTtl: true,
      silent: true,
    });
  });

  it('is always silent, so a background run cannot hijack /sync/status', async () => {
    await task.digestLead();
    await task.mailWindow();

    for (const call of refreshAll.mock.calls) {
      expect(call[0].silent).toBe(true);
    }
  });

  it('keeps going when one household throws, and never rejects', async () => {
    // An unhandled rejection out of a cron callback takes the scheduler down
    // and silently stops everything else on it.
    connectionFindMany.mockResolvedValue([{ id: 'conn-1' }, { id: 'conn-2' }]);
    refreshAll.mockImplementation(({ connectionId }: { connectionId: string }) =>
      connectionId === 'conn-1' ? Promise.reject(new Error('upstream 502')) : Promise.resolve(),
    );

    await expect(task.digestLead()).resolves.toBeUndefined();

    const touched = refreshAll.mock.calls.map((call) => call[0].connectionId);
    expect(touched).toContain('conn-2');
  });

  it('does not reject when the household lookup itself fails', async () => {
    digestRecipientFindMany.mockRejectedValue(new Error('db down'));

    await expect(task.digestLead()).resolves.toBeUndefined();
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('walks households one at a time', async () => {
    // Two simultaneous Mashov logins from one household is asking for a rate
    // limit, which is why the manual path is concurrency 1 too.
    connectionFindMany.mockResolvedValue([{ id: 'conn-1' }, { id: 'conn-2' }]);
    let inFlight = 0;
    let maxInFlight = 0;
    refreshAll.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await task.digestLead();

    expect(maxInFlight).toBe(1);
  });
});

/** Minutes-from-midnight of every firing of an `M H * * *` expression. */
function minutesOf(expression: string): number[] {
  const [minuteField, hourField] = expression.split(' ');
  const out: number[] = [];
  for (const hour of expandField(hourField, 23)) {
    for (const minute of expandField(minuteField, 59)) {
      out.push(hour * 60 + minute);
    }
  }
  return out.sort((a, b) => a - b);
}

function hoursOf(expression: string): number[] {
  return expandField(expression.split(' ')[1], 23);
}

function expandField(field: string, max: number): number[] {
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2));
    const out: number[] = [];
    for (let value = 0; value <= max; value += step) out.push(value);
    return out;
  }
  if (field.includes('-')) {
    const [from, to] = field.split('-').map(Number);
    const out: number[] = [];
    for (let value = from; value <= to; value += 1) out.push(value);
    return out;
  }
  return [Number(field)];
}
