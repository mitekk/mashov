import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncService } from '../sync.service';

/**
 * The only remaining sync cron.
 *
 * Every per-task `@Cron` is gone. They fanned out across *every* active
 * household and *every* active child on fixed schedules whether or not anyone
 * was looking — roughly 1,300–1,400 upstream requests and ~48 full logins per
 * household per day, much of it for data no page renders. On a public
 * deployment that is an abuse signal upstream and needless write load here.
 *
 * What replaces it: background sync runs **only** for households that opted
 * into notifications, and only just before their delivery window. A household
 * with notifications off gets zero background upstream traffic — it syncs at
 * login and when the user asks.
 *
 * ## The flags are load-bearing
 *
 * `DIGEST_ENABLED` and `INBOX_NOTIFY_ENABLED` both default to **false**, so a
 * default deployment does **no background sync at all**. That is the intended
 * public-resource posture, not a bug. Gating on them is deliberate: if the
 * digest cannot send, pre-fetching for it is pure upstream waste.
 *
 * Gated on `*_ENABLED` only, never on `*_DRY_RUN`. A dry run still exercises
 * the collector, still writes `digest_delivery` rows, and still distinguishes
 * `skipped_stale` from `skipped_empty` — all of which need fresh data.
 */
@Injectable()
export class NotificationWindowTask {
  private readonly logger = new Logger(NotificationWindowTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sync: SyncService,
  ) {}

  /**
   * Fetches what the digest reports on, shortly before it runs.
   *
   * At :50 of 10–18, so each of `DigestTask`'s 11:00–19:00 ticks sees data
   * ~10 minutes old. **This is what satisfies the digest's 6h staleness
   * trip-wire** (`SYNC_STALE_AFTER_MS` in `digest.service.ts`), whose own
   * comment justifies 6h by "the sync tasks run every 12 minutes" — the crons
   * this class replaces. Lose that relationship and every quiet child is
   * reported `skipped_stale` instead of `skipped_empty`, permanently.
   * The "digest-lead tick stays inside the digest staleness trip-wire" suite
   * in this task's own spec pins it, reading the real `SYNC_STALE_AFTER_MS`
   * and this very cron expression, so a schedule edit fails a test.
   *
   * `respectTtl` means most ticks are cheap: `homework`/`behavior` carry a
   * 45-minute TTL, so ~5 of the 9 ticks actually fetch, and `timetable`/`bells`
   * (7 days) fetch about once a week.
   */
  @Cron('50 10-18 * * *', { timeZone: 'Asia/Jerusalem' })
  async digestLead(): Promise<void> {
    if (!this.isEnabled('DIGEST_ENABLED')) return;
    await this.runForNotifiedHouseholds('digest', async (connectionId) => {
      // Folded in here rather than given a cron of its own: the roster's
      // 24h TTL makes this at-most-daily per connection with no new state,
      // the same trick `ensureStudentsAvailable` uses. The roster changes
      // about once a year; it used to re-login every 30 minutes.
      //
      // `respectTtl` is what makes that true, and it only reaches the roster
      // because `runManualRefresh` probes `students` explicitly -- it is not
      // in `buildTasks`. See the comment there before changing either.
      await this.sync.refreshAll({
        connectionId,
        taskSet: 'roster',
        respectTtl: true,
        silent: true,
      });
      await this.sync.refreshAll({
        connectionId,
        taskSet: 'digest',
        respectTtl: true,
        silent: true,
      });
    });
  }

  /**
   * Fetches mail inside the inbox notifier's own non-quiet window.
   *
   * `InboxNotifyTask` keeps its ten-minute cron: it reads our own database to
   * detect arrivals and costs nothing upstream. The only consequence of a
   * 30-minute fetch is that arrival detection lags by up to 30 minutes instead
   * of 7 — absorbed by its 24h `INBOX_NOTIFY_LOOKBACK_HOURS` and the
   * `mail_notified_message` ledger, so nothing is lost, only delayed.
   *
   * The 7–20 range mirrors `INBOX_NOTIFY_QUIET_FROM`/`TO` (21:00→07:00).
   * "The mail window covers the inbox notifier" in this task's own spec
   * expands both and asserts this cron runs through every non-quiet hour, so
   * narrowing the quiet window without widening this fails a test rather than
   * silently leaving hours where the notifier is awake and nothing fetches.
   */
  @Cron('*/30 7-20 * * *', { timeZone: 'Asia/Jerusalem' })
  async mailWindow(): Promise<void> {
    if (!this.isEnabled('INBOX_NOTIFY_ENABLED')) return;
    await this.runForNotifiedHouseholds('mail', async (connectionId) => {
      await this.sync.refreshAll({
        connectionId,
        taskSet: 'mail',
        respectTtl: true,
        silent: true,
      });
    });
  }

  /**
   * Walks the connections of households that opted into notifications.
   *
   * Sequential, concurrency 1, for the reason `SyncController.refresh` already
   * gives: "two simultaneous Mashov logins from one household is asking for a
   * rate limit". Never throws — an unhandled rejection out of a cron callback
   * takes the scheduler down and silently stops everything else on it.
   */
  private async runForNotifiedHouseholds(
    label: string,
    body: (connectionId: string) => Promise<void>,
  ): Promise<void> {
    const startedAt = Date.now();
    let connectionIds: string[];
    try {
      connectionIds = await this.notifiedConnectionIds();
    } catch (error) {
      this.logger.error(`${label}: could not resolve notified households: ${describe(error)}`);
      return;
    }

    if (connectionIds.length === 0) {
      this.logger.debug(`${label}: no household has notifications enabled; nothing to sync`);
      return;
    }

    const budgetMs = this.envInt('NOTIFY_SYNC_TICK_BUDGET_MS', 600_000);
    // Zero is a meaningful value here -- it turns jitter off -- so this one
    // admits it, unlike the budget, where zero would abandon every tick.
    const jitterMs = this.envInt('NOTIFY_SYNC_JITTER_MS', 15_000, true);
    let done = 0;

    for (const connectionId of connectionIds) {
      // An overrunning tick must not collide with the next one.
      if (Date.now() - startedAt > budgetMs) {
        this.logger.warn(
          `${label}: tick budget of ${budgetMs}ms spent after ${done}/${connectionIds.length} ` +
            `connections; skipping the rest this tick`,
        );
        return;
      }
      // Keeps N households off the same second. Sequential execution does most
      // of the spreading; this is mainly to de-align the first one from the
      // cron boundary.
      await sleep(Math.floor(Math.random() * jitterMs));
      try {
        await body(connectionId);
      } catch (error) {
        this.logger.error(`${label}: sync failed for connection ${connectionId}: ${describe(error)}`);
      }
      done += 1;
    }

    this.logger.log(`${label}: synced ${done} connection(s) in ${Date.now() - startedAt}ms`);
  }

  /**
   * The connections of households with at least one enabled digest recipient.
   *
   * Two narrow indexed queries, and deliberately **not**
   * `DigestRecipientService.listDeliveryTargets()`. That returns per-(child,
   * parent) targets and runs `stillDeliverable`, which is send-time
   * correctness work, not scheduling work — and reaching for it would mean
   * importing `DigestModule`, which documents that it imports neither
   * `MashovSessionModule` nor anything building a Mashov axios client because
   * `HTTPS_PROXY` is process-wide (ADR-0023). A target refused at send time
   * still gets pre-fetched here; that is harmless.
   */
  private async notifiedConnectionIds(): Promise<string[]> {
    const recipients = await this.prisma.digestRecipient.findMany({
      where: { enabled: true },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (recipients.length === 0) return [];

    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { in: recipients.map((row) => row.userId) },
        active: true,
      },
      select: { id: true },
      orderBy: { lastLoginAt: 'desc' },
    });
    return connections.map((row) => row.id);
  }

  /** Defaults to false: these crons stay off until deliberately enabled. */
  private isEnabled(name: 'DIGEST_ENABLED' | 'INBOX_NOTIFY_ENABLED'): boolean {
    const raw = this.config.get<string | boolean>(name);
    return String(raw ?? 'false').trim().toLowerCase() === 'true';
  }

  private envInt(name: string, fallback: number, allowZero = false): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    // A typo must not silently become an aggressive schedule.
    if (parsed < 0 || (parsed === 0 && !allowZero)) return fallback;
    return parsed;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the event loop open for jitter.
    timer.unref?.();
  });
}
