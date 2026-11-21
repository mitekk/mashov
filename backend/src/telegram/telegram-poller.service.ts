import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from './telegram.client';
import { TelegramLinkService, TelegramUpdate } from './telegram-link.service';

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
/** After a transient failure, long enough not to hammer a struggling API. */
const RETRY_DELAY_MS = 5_000;
/** After a 409 from a second replica: a misconfiguration, not a blip. */
const CONFLICT_DELAY_MS = 60_000;
/**
 * How many times one update may fail processing before it is abandoned.
 *
 * Both failure modes are real and they pull opposite ways. A transient one -- a
 * Postgres restart, a pool timeout -- must not cost the parent their START,
 * because confirming the update is what makes Telegram drop it and the
 * 24-hour retention is the only safety net there is. A genuinely malformed one
 * must not be re-delivered for a day with every later update stuck behind it.
 * The code cannot tell them apart, so it retries a few times and then gives up
 * loudly.
 */
const MAX_UPDATE_ATTEMPTS = 3;

/**
 * The long-polling loop, and nothing else.
 *
 * Long-polling rather than a webhook because a webhook needs a public HTTPS URL
 * with a valid certificate that Telegram can reach, and this stack is local
 * Docker behind NAT whose only outbound hop is a residential tinyproxy
 * (ADR-0023) -- there is nothing for Telegram to call. `getUpdates` is
 * outbound-only and needs no ingress at all. The two are mutually exclusive on
 * one bot, so whichever runs, the other must be explicitly off; a webhook set
 * on the bot stops this loop rather than making it retry blindly.
 *
 * Every decision this class makes is about *when* to poll. What an update means
 * is entirely `TelegramLinkService`'s, which is what lets that logic be spec'd
 * with a hand-built update object and no timer and no network anywhere.
 *
 * Single replica assumed, the same assumption `inFlightManualRefreshByConnection`
 * already carries: two replicas both polling would make Telegram 409 at one of
 * them. See ADR-0033.
 */
@Injectable()
export class TelegramPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPollerService.name);

  /**
   * In memory on purpose. The offset is only a confirmation marker: Telegram
   * retains unconfirmed updates for 24 hours, so a restart is handed back
   * exactly what this process had not yet acknowledged. Persisting it would
   * mean either a Redis key `allkeys-lru` may evict or a table whose only job
   * is a counter.
   */
  private offset: number | undefined;

  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  /** update_id -> consecutive processing failures. Cleared on success. */
  private readonly failures = new Map<number, number>();

  constructor(
    private readonly client: TelegramClient,
    private readonly links: TelegramLinkService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.shouldPoll()) {
      // Logged once, at startup, and then never again: the default deployment
      // has no bot token and must not produce a line per poll about it.
      this.logger.log(
        'Telegram link polling is off (no TELEGRAM_BOT_TOKEN, TELEGRAM_POLL_ENABLED=false, or test run).',
      );
      return;
    }
    this.logger.log('Telegram link polling started.');
    this.scheduleNext(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Whether this process should run the loop at all. */
  shouldPoll(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    if (!this.client.hasToken()) return false;

    const raw = this.config.get<string | boolean>('TELEGRAM_POLL_ENABLED');
    // Defaults on, but inert without a token, which the check above covers.
    if (raw === undefined || raw === null || raw === '') return true;
    return String(raw).trim().toLowerCase() !== 'false';
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * One long poll and everything it handed over, returning how long to wait
   * before the next one. Separate from the scheduling so a spec can drive it
   * without a timer.
   */
  async pollOnce(): Promise<number> {
    if (this.stopped) return RETRY_DELAY_MS;

    let updates: unknown[];
    try {
      updates = await this.client.getUpdates(this.offset, this.pollTimeoutSeconds());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/webhook is active/i.test(message)) {
        this.stopped = true;
        this.logger.error(
          `Telegram link polling stopped: a webhook is set on this bot, and getUpdates cannot ` +
            `run alongside one. Delete the webhook or set TELEGRAM_POLL_ENABLED=false. (${message})`,
        );
        return RETRY_DELAY_MS;
      }
      if (/terminated by other getUpdates/i.test(message)) {
        this.logger.error(
          `Telegram link polling conflicted with another poller on the same bot -- more than one ` +
            `backend replica is running. Only one may poll. (${message})`,
        );
        return CONFLICT_DELAY_MS;
      }
      this.logger.warn(`Telegram getUpdates failed, will retry: ${message}`);
      return RETRY_DELAY_MS;
    }

    // Telegram should always answer with an array, but `result` is whatever
    // came over the wire. A non-array here used to throw out of the loop below,
    // and because scheduleNext lives in a `.then()` the loop simply stopped --
    // process healthy, HTTP served, every parent's START ignored, and
    // `stopped` still false so nothing said so.
    if (!Array.isArray(updates)) {
      this.logger.warn('Telegram getUpdates returned no update list; skipping this batch.');
      return RETRY_DELAY_MS;
    }

    // The lowest update this batch must NOT confirm, because processing it
    // failed and it should come back. `offset` is "the first id I have not
    // accounted for", so leaving it at that id is what asks for a redelivery.
    let blocked: number | undefined;
    let highest = this.offset === undefined ? undefined : this.offset - 1;

    for (const update of updates) {
      const parsed = update as TelegramUpdate;
      const id = parsed?.update_id;
      if (typeof id !== 'number') continue;
      highest = highest === undefined ? id : Math.max(highest, id);

      try {
        await this.links.consume(parsed);
        // Consecutive, not cumulative: an update that recovers starts over.
        this.failures.delete(id);
      } catch (error) {
        const attempts = (this.failures.get(id) ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);

        if (attempts >= MAX_UPDATE_ATTEMPTS) {
          this.failures.delete(id);
          this.logger.error(
            `Telegram update ${id} failed ${attempts} times and is being abandoned so later ` +
              `updates are not blocked behind it: ${message}`,
          );
          continue;
        }

        this.failures.set(id, attempts);
        blocked = blocked === undefined ? id : Math.min(blocked, id);
        this.logger.warn(
          `Telegram update ${id} could not be processed (attempt ${attempts}/` +
            `${MAX_UPDATE_ATTEMPTS}), leaving it unconfirmed to be retried: ${message}`,
        );
      }
    }

    if (blocked !== undefined) this.offset = blocked;
    else if (highest !== undefined) this.offset = highest + 1;

    // A failed update means a moment's pause before asking for it again;
    // otherwise straight back in, since getUpdates itself is the wait.
    return blocked === undefined ? 0 : RETRY_DELAY_MS;
  }

  /** The self-rescheduling half: one poll, then book the next one. */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      // The catch is load-bearing, not defensive dressing: without it a
      // rejection from pollOnce would skip scheduleNext entirely and the loop
      // would end, silently and permanently.
      void this.pollOnce()
        .catch((error) => {
          this.logger.error(
            `Telegram poll threw unexpectedly: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return RETRY_DELAY_MS;
        })
        .then((nextDelayMs) => this.scheduleNext(nextDelayMs));
    }, delayMs);
    // Never hold the process open on account of a poll that is merely waiting.
    this.timer.unref?.();
  }

  private pollTimeoutSeconds(): number {
    const raw = Number(this.config.get<string>('TELEGRAM_POLL_TIMEOUT_SECONDS'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_TIMEOUT_SECONDS;
  }
}
