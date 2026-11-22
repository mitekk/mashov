import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { DigestCheckerService, STALE_CLAIM_MS } from './digest-checker.service';
import { DigestCollectorService } from './digest-collector.service';
import { DigestSummarizerService } from './digest-summarizer.service';
import { DigestRecipientService, DigestDeliveryTarget } from './digest-recipient.service';
import { DigestSender } from './senders/digest-sender.interface';
import { TelegramSender } from './senders/telegram.sender';
import { LogSender } from './senders/log.sender';
import { jerusalemDayBounds } from './digest-deadline.service';
import { deterministicLines, renderReport } from './digest-report.template';
import { DigestCandidate, DigestHomeworkFact, DigestPayload, DigestSummary } from './digest.types';

/**
 * The key a child's prose is memoized under for one run.
 *
 * Activity hashes are excluded because they embed the owning `userId`, so two
 * parents' claims for the same form hash differently -- and the forms are not
 * in the summarizer's payload anyway. Every other hash is derived from the
 * child's own row, so an equal key means an equal payload.
 */
function summaryKeyFor(studentGuid: string, claimed: DigestCandidate[]): string {
  const hashes = claimed
    .filter((candidate) => candidate.itemType !== 'activity')
    .map((candidate) => candidate.contentHash)
    .sort();
  return `${studentGuid}\u0000${hashes.join('|')}`;
}

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

/**
 * How stale the school data may be before a quiet day stops being reported as
 * quiet. The sync tasks run every 12 minutes, so six hours means several dozen
 * consecutive failures -- comfortably past a transient blip.
 */
const SYNC_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Mirrors DigestCheckerService's default; both read the same env var. */
const DEFAULT_DUE_LOOKBACK_DAYS = 14;

/**
 * Sources whose freshness decides whether "nothing happened" is believable.
 *
 * These are base names. The sync tasks open their runs per child
 * (`homework:<guid>` -- homework.task.ts:65, behavior.task.ts:74), so matching
 * the base name alone finds no row ever and silently turns this whole guard
 * into dead code. Both shapes are matched: the per-child name the tasks write
 * today, and the bare base name, in case a future task runs household-wide.
 */
const SYNC_SOURCES_BEHIND_THE_DIGEST = ['homework', 'behavior'];

export type DigestRunStatus = 'sent' | 'skipped_empty' | 'skipped_stale' | 'failed' | 'dry_run';

export interface DigestRunResult {
  studentGuid: string;
  /** The subscribing parent this run was for: one result per (child, user). */
  userId: string;
  status: DigestRunStatus;
  itemCount: number;
  recipientCount: number;
  usedLlm: boolean;
  error?: string;
}

export interface DigestRunOptions {
  now?: Date;
  dryRun?: boolean;
  /** Run one child only -- used by the manual-run endpoint. */
  studentGuid?: string;
  /**
   * Scopes the run to children this user has a recipient row for. The cron
   * leaves it unset and runs every opted-in child; the manual endpoint always
   * sets it, because there is no child -> parent FK to validate a studentGuid
   * against and a run both spends model tokens and sends real messages.
   */
  userId?: string;
}

/**
 * Orchestrates one digest run: enumerate the opted-in children, check, claim,
 * collect, summarize, send, confirm.
 *
 * The claim protocol is the delicate part. `createMany({skipDuplicates})`
 * reports how many rows it inserted but never which, so ownership is made
 * readable instead of inferred: each run stamps `claimedBy` with its own id and
 * then reads back its own rows. Everything downstream -- what to collect, what
 * to confirm, what to release -- is scoped to those rows. Inferring ownership
 * from the count is what allowed a run to send an item another run was already
 * sending, and allowed a failing run to delete a claim a live run was holding.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  /**
   * In-process guard so a slow run never overlaps itself -- the hourly cron
   * would otherwise start a second pass over the same children while the first
   * is still waiting on a model or on Telegram. Precedent:
   * inFlightManualRefreshByConnection in sync.service.ts. It is a convenience,
   * not the correctness mechanism; `claimedBy` is.
   */
  private running = false;

  private readonly senders: DigestSender[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schoolYear: SchoolYearService,
    private readonly checker: DigestCheckerService,
    private readonly collector: DigestCollectorService,
    private readonly summarizer: DigestSummarizerService,
    private readonly recipients: DigestRecipientService,
    // Typed as the interface, injected by concrete class: the channel is meant
    // to be a configuration detail, and the orchestrator should not know how
    // either sender works.
    @Inject(TelegramSender) telegram: DigestSender,
    @Inject(LogSender) private readonly logSender: DigestSender,
  ) {
    this.senders = [telegram, logSender];
  }

  async runAll(options: DigestRunOptions = {}): Promise<DigestRunResult[]> {
    if (this.running) {
      this.logger.warn('A digest run is already in flight; skipping this tick.');
      return [];
    }
    this.running = true;

    try {
      const now = options.now ?? new Date();
      const dryRun = options.dryRun ?? this.isDryRunByDefault();

      const allTargets = await this.recipients.listDeliveryTargets(options.userId);
      const targets = options.studentGuid
        ? allTargets.filter((target) => target.studentGuid === options.studentGuid)
        : allTargets;

      if (targets.length === 0) return [];

      if (dryRun && this.isEnabledByConfig()) {
        // Worth saying out loud: this combination spends a model call per child
        // per run and delivers nothing to anybody, indefinitely.
        this.logger.warn(
          'DIGEST_ENABLED is true but DIGEST_DRY_RUN is also true: digests are being rendered and discarded.',
        );
      }

      // Resolved once per run, not per child: currentSchoolYearFor is DB-only,
      // but it is still a query, and every child in a household shares it.
      // Never resolveForSchool() -- that calls /api/schools through the Mashov
      // residential proxy, which this module must never touch.
      const schoolYear = await this.schoolYear.currentSchoolYearFor();

      // Staleness depends on the child alone, so two parents of one child ask
      // the same question. Memoized for the run, not held between runs: a
      // sync that recovers mid-afternoon must be visible to the next tick.
      const staleness = new Map<string, Date | null>();

      // What this run has already put in front of a chat, as
      // channel + address + hash(text). Two parents of one child who linked
      // the same family chat each get their own run now, so without this the
      // chat receives the same message twice in a row. Byte-identical only:
      // if their consent forms differ the messages differ and both are news.
      // Per run, never held between runs -- the ledger is what stops a repeat
      // tomorrow.
      const alreadySent = new Set<string>();

      // One model call per child per run, as before this became per-parent.
      // Keyed on the child and the non-activity content hashes it claimed:
      // those hashes are userId-independent by construction, so an equal key
      // means an equal payload. Per run, so a change between runs is seen.
      const summaries = new Map<string, DigestSummary>();

      const results: DigestRunResult[] = [];
      // Strictly sequential, and not only for the per-child isolation
      // homework.task.ts wants. Consent-form dedup across a parent's children
      // rests on the checker seeing the previous target's ledger row, so a
      // `Promise.all` over the targets of one household would send the same
      // form twice. See ADR-0035.
      for (const target of targets) {
        results.push(
          await this.runForChild(
            target,
            schoolYear,
            now,
            dryRun,
            staleness,
            alreadySent,
            summaries,
          ),
        );
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private async runForChild(
    target: DigestDeliveryTarget,
    schoolYear: number,
    now: Date,
    dryRun: boolean,
    staleness: Map<string, Date | null>,
    alreadySent: Set<string>,
    summaries: Map<string, DigestSummary>,
  ): Promise<DigestRunResult> {
    const { studentGuid, userId } = target;
    const { tomorrowStart, reportFor: defaultReportFor } = jerusalemDayBounds(now, this.timeZone());
    const runId = randomUUID();
    let reportFor = defaultReportFor;
    let claimed: DigestCandidate[] = [];

    try {
      const check = await this.checker.check({
        studentGuid,
        schoolYear,
        now,
        activeFrom: target.activeFrom,
        userId,
      });
      reportFor = check.reportFor;

      if (check.candidates.length === 0) {
        return await this.recordQuiet(userId, studentGuid, reportFor, now, staleness);
      }

      claimed = await this.claim(
        userId,
        studentGuid,
        check.candidates,
        reportFor,
        runId,
        now,
        tomorrowStart,
      );
      if (claimed.length === 0) {
        this.logger.log(
          `Digest ${studentGuid}: every item is owned by another run or already delivered; sending nothing.`,
        );
        return await this.recordEmpty(userId, studentGuid, reportFor, 'already claimed elsewhere');
      }

      const payload = await this.collector.collect({
        studentGuid,
        candidates: claimed,
        reportFor,
        userId,
      });

      // Without the consent forms. They belong to this parent rather than to
      // the child, while everything else in the payload is the same for both
      // of a child's parents -- which is what lets one summary serve both
      // runs. The section is rendered from the deterministic line instead.
      //
      // Shared, not re-requested: the summary is read-only downstream, so the
      // other parent's run for the same child and the same claimed items gets
      // the same object rather than a second Sonnet call.
      const summaryKey = summaryKeyFor(studentGuid, claimed);
      const memoed = summaries.get(summaryKey);
      const summary =
        memoed ?? (await this.summarizer.summarize({ ...payload, activities: [] }));
      summaries.set(summaryKey, summary);
      const { payload: narrowed, resolutionByItemId } = narrowDueTomorrow(
        payload,
        summary,
        tomorrowStart,
      );

      const surviving = survivingHashes(claimed, narrowed);

      if (surviving.size === 0) {
        // Everything the checker widened in turned out not to be due tomorrow.
        await this.settleUnsent(
          userId,
          studentGuid,
          claimed,
          surviving,
          resolutionByItemId,
          runId,
          tomorrowStart,
        );
        return await this.recordEmpty(
          userId,
          studentGuid,
          reportFor,
          'no item survived deadline resolution',
        );
      }

      const lines = linesFor(summary, payload, narrowed);
      const message = renderReport(narrowed, lines);

      const enabled = await this.prisma.digestRecipient.findMany({
        where: { userId, studentGuid, enabled: true },
        select: { channel: true, address: true },
      });

      if (enabled.length === 0 && !dryRun) {
        // Recipients are re-read here, per child, after the model call --
        // minutes after the run enumerated its targets. A parent who disabled
        // or deleted their last recipient in that window must not have the
        // day's items confirmed as reported: confirming them would bury this
        // behaviour and homework permanently, because the content hashes stay
        // in the ledger and nothing ever re-reports an item already in it.
        await this.releaseClaims(userId, studentGuid, claimed, runId);
        return await this.recordEmpty(userId, studentGuid, reportFor, 'no enabled recipient left');
      }

      const { delivered, failures, suppressed } = await this.deliver(
        enabled,
        message,
        dryRun,
        alreadySent,
      );

      if (delivered === 0 && enabled.length > 0) {
        throw new Error(`no recipient could be reached (${failures.join('; ')})`);
      }

      const itemCount = countItems(narrowed);

      if (dryRun) {
        // A dry run must not mark anything reported, or the first real run
        // would find nothing left to say.
        await this.releaseClaims(userId, studentGuid, claimed, runId);
        return await this.record(userId, studentGuid, reportFor, {
          status: 'dry_run',
          itemCount,
          recipientCount: enabled.length,
          usedLlm: summary.usedLlm,
          messageText: message,
          channel: this.logSender.channel,
        });
      }

      await this.settleUnsent(
        userId,
        studentGuid,
        claimed,
        surviving,
        resolutionByItemId,
        runId,
        tomorrowStart,
      );
      await this.confirmClaims(userId, studentGuid, [...surviving], runId);

      return await this.record(userId, studentGuid, reportFor, {
        status: 'sent',
        itemCount,
        recipientCount: delivered,
        usedLlm: summary.usedLlm,
        messageText: message,
        channel: enabled[0]?.channel ?? null,
        // A partial failure is recorded but does not undo a real delivery.
        // The suppression note rides on the same field, so support can tell
        // "sent" from "the other parent's run sent this exact text already".
        errorMessage: deliveryNote(failures, suppressed),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Digest failed for ${studentGuid}: ${message}`);

      // Roll our own claim back so the next hourly run retries. Scoped to this
      // run's id so a concurrent run's claim is never deleted.
      if (claimed.length > 0) {
        await this.releaseClaims(userId, studentGuid, claimed, runId).catch(() => undefined);
      }

      return await this.record(userId, studentGuid, reportFor, {
        status: 'failed',
        itemCount: 0,
        recipientCount: 0,
        usedLlm: false,
        errorMessage: message,
      });
    }
  }

  /**
   * Claims candidates and returns only those this run actually owns.
   *
   * Three steps, because a claim can be in three states. A brand-new item is
   * inserted. An item whose row exists but was abandoned -- unconfirmed past
   * the staleness window, because the run holding it was killed between
   * claiming and sending -- is taken over. An item previously deferred to a
   * date that is now tomorrow is also taken over. Everything else belongs to
   * someone else or is already delivered.
   *
   * The read-back is not redundant: the insert's count says how many rows were
   * won, never which, and acting on the full candidate list instead is how an
   * item gets sent twice.
   */
  private async claim(
    userId: string,
    studentGuid: string,
    candidates: DigestCandidate[],
    reportFor: Date,
    runId: string,
    now: Date,
    tomorrowStart: Date,
  ): Promise<DigestCandidate[]> {
    const hashes = candidates.map((candidate) => candidate.contentHash);

    await this.prisma.digestReportedItem.createMany({
      data: candidates.map((candidate) => ({
        userId,
        studentGuid,
        itemType: candidate.itemType,
        itemId: candidate.itemId,
        contentHash: candidate.contentHash,
        reportedFor: reportFor,
        claimedBy: runId,
      })),
      skipDuplicates: true,
    });

    await this.prisma.digestReportedItem.updateMany({
      where: {
        // `userId` is load-bearing here, not decoration. This is the only
        // write in the claim protocol not already scoped by `claimedBy`, so
        // without it user A's run restamps user B's rows -- claimedBy=A,
        // confirmedAt=null -- and B's own confirm and settle then match
        // nothing, so the item is re-reported to B half an hour later.
        userId,
        studentGuid,
        contentHash: { in: hashes },
        OR: [
          // Abandoned by a run that died before sending.
          { confirmedAt: null, claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
          // Deferred to a deadline that has now arrived.
          { confirmedAt: { not: null }, resolvedDueDate: tomorrowStart },
        ],
      },
      data: { claimedBy: runId, claimedAt: now, confirmedAt: null, resolvedDueDate: null },
    });

    const owned = await this.prisma.digestReportedItem.findMany({
      where: { userId, studentGuid, claimedBy: runId },
      select: { contentHash: true },
    });
    const ownedHashes = new Set(owned.map((row) => row.contentHash));

    return candidates.filter((candidate) => ownedHashes.has(candidate.contentHash));
  }

  /** Sends to each recipient independently, so one bad address cannot undo the rest. */
  private async deliver(
    recipients: { channel: string; address: string }[],
    message: string,
    dryRun: boolean,
    alreadySent: Set<string>,
  ): Promise<{ delivered: number; failures: string[]; suppressed: number }> {
    let delivered = 0;
    let suppressed = 0;
    const failures: string[] = [];
    const digest = createHash('sha256').update(message).digest('hex');

    for (const recipient of recipients) {
      const fingerprint = `${recipient.channel}\u0000${recipient.address}\u0000${digest}`;
      if (alreadySent.has(fingerprint)) {
        // Counted as delivered, deliberately: the parent has the message. The
        // `delivered === 0` guard below throws, which releases the claims --
        // so a run whose only recipient was suppressed would retry the same
        // suppressed send every hour, with a fresh model call each time, and
        // never confirm anything.
        suppressed += 1;
        delivered += 1;
        continue;
      }

      try {
        const sender = dryRun ? this.logSender : this.senderFor(recipient.channel);
        await sender.send(recipient.address, message);
        delivered += 1;
        alreadySent.add(fingerprint);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Digest delivery to ${recipient.channel} failed: ${reason}`);
        failures.push(reason);
      }
    }

    return { delivered, failures, suppressed };
  }

  /**
   * Decides what to do with claims that were not part of the sent report.
   *
   * A `homework_due` item the model dated to some later day is *deferred*: the
   * row stays, confirmed, with that date recorded, so the model is not asked
   * the same question on all seven of today's runs nor on every run for the
   * fortnight the item stays in the lookback -- and the checker re-admits it on
   * the day the date is tomorrow.
   *
   * An item with no resolvable date at all is released instead. There is
   * nothing to defer to, and confirming it would bury it permanently: the
   * content hash does not include the estimate, so a later timetable sync that
   * finally gives its group a lesson tomorrow would never resurface it.
   *
   * So is an item whose date the deferral could never be collected on. A
   * deferral is a promise to look again on a particular day, and the checker
   * can only keep it while the row is still inside the due-candidate lookback
   * (`lessonDate >= day - DIGEST_DUE_LOOKBACK_DAYS`). A date beyond that
   * horizon, or one the model read as already past -- a wrong-year reading of
   * Hebrew text that names no year is the ordinary way this happens -- is
   * released, so the item is simply re-evaluated next run instead of being
   * buried by a promise nobody can keep.
   */
  private async settleUnsent(
    userId: string,
    studentGuid: string,
    claimed: DigestCandidate[],
    surviving: Set<string>,
    resolutionByItemId: Map<string, Date | null>,
    runId: string,
    tomorrowStart: Date,
  ): Promise<void> {
    const unsent = claimed.filter((candidate) => !surviving.has(candidate.contentHash));
    if (unsent.length === 0) return;

    const byDate = new Map<number, string[]>();
    const toRelease: DigestCandidate[] = [];

    const lookbackDays = this.readDays('DIGEST_DUE_LOOKBACK_DAYS', DEFAULT_DUE_LOOKBACK_DAYS);

    for (const candidate of unsent) {
      const resolved =
        candidate.itemType === 'homework_due'
          ? resolutionByItemId.get(candidate.itemId) ?? candidate.estimatedDueDate ?? null
          : null;
      if (resolved === null || !this.isReachableAgain(resolved, candidate, tomorrowStart, lookbackDays)) {
        toRelease.push(candidate);
        continue;
      }
      const key = resolved.getTime();
      byDate.set(key, [...(byDate.get(key) ?? []), candidate.contentHash]);
    }

    for (const [time, hashes] of byDate) {
      await this.prisma.digestReportedItem.updateMany({
        where: { userId, studentGuid, claimedBy: runId, contentHash: { in: hashes } },
        data: { confirmedAt: new Date(), resolvedDueDate: new Date(time), claimedBy: null },
      });
    }

    if (toRelease.length > 0) {
      await this.releaseClaims(userId, studentGuid, toRelease, runId);
    }
  }

  /**
   * Whether the checker will still re-query this row on the deferred day.
   *
   * The due-candidate query windows on `lessonDate`, so a row stays visible
   * until `lessonDate + lookback`. A date past that, or a date not in the
   * future at all, is a deferral that would never be collected.
   */
  private isReachableAgain(
    resolved: Date,
    candidate: DigestCandidate,
    tomorrowStart: Date,
    lookbackDays: number,
  ): boolean {
    if (resolved.getTime() < tomorrowStart.getTime()) return false;
    const from = candidate.itemDate ?? tomorrowStart;
    const horizon = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + lookbackDays),
    );
    return resolved.getTime() <= horizon.getTime();
  }

  private senderFor(channel: string): DigestSender {
    const sender = this.senders.find((candidate) => candidate.channel === channel);
    if (!sender) throw new Error(`No digest sender for channel "${channel}".`);
    return sender;
  }

  /** Marks items as fully reported. `resolvedDueDate` null means exactly that. */
  private async confirmClaims(
    userId: string,
    studentGuid: string,
    hashes: string[],
    runId: string,
  ): Promise<void> {
    await this.prisma.digestReportedItem.updateMany({
      where: { userId, studentGuid, claimedBy: runId, contentHash: { in: hashes } },
      data: { confirmedAt: new Date(), resolvedDueDate: null, claimedBy: null },
    });
  }

  /**
   * Deletes this run's own claims, so the next run sees the items as
   * unreported. Scoped to `claimedBy` so a failing or dry run cannot delete a
   * claim a concurrent run is holding.
   */
  private async releaseClaims(
    userId: string,
    studentGuid: string,
    claimed: DigestCandidate[],
    runId: string,
  ): Promise<void> {
    await this.prisma.digestReportedItem.deleteMany({
      where: {
        userId,
        studentGuid,
        claimedBy: runId,
        contentHash: { in: claimed.map((candidate) => candidate.contentHash) },
      },
    });
  }

  /**
   * A day with no candidates is only a quiet day if the school data is current.
   * The digest reads local Postgres, so a dead session or a stalled sync task
   * looks exactly like "nothing happened" -- and leaving a parent to read
   * silence as reassurance is the wrong default when the truth is that we have
   * not spoken to the school since Tuesday.
   */
  private async recordQuiet(
    userId: string,
    studentGuid: string,
    reportFor: Date,
    now: Date,
    staleness: Map<string, Date | null>,
  ): Promise<DigestRunResult> {
    const memoed = staleness.get(studentGuid);
    const staleSince =
      memoed !== undefined ? memoed : await this.staleSyncSince(now, studentGuid);
    staleness.set(studentGuid, staleSince);
    if (staleSince === null) {
      return this.recordEmpty(userId, studentGuid, reportFor, 'nothing unreported');
    }

    this.logger.warn(
      `Digest ${studentGuid}: no items, but school data has not synced successfully since ${staleSince.toISOString()}.`,
    );
    return this.record(userId, studentGuid, reportFor, {
      status: 'skipped_stale',
      itemCount: 0,
      recipientCount: 0,
      usedLlm: false,
      errorMessage: `school data last synced ${staleSince.toISOString()}`,
    });
  }

  /**
   * The oldest last-success among the sources the digest reads, if stale.
   *
   * Scoped to the child being reported: the tasks sync each child under their
   * own source name, so one child's dead session must not make another child's
   * quiet day look stale, nor the reverse.
   */
  private async staleSyncSince(now: Date, studentGuid: string): Promise<Date | null> {
    const cutoff = new Date(now.getTime() - SYNC_STALE_AFTER_MS);
    let oldest: Date | null = null;

    for (const base of SYNC_SOURCES_BEHIND_THE_DIGEST) {
      const run = await this.prisma.syncRun.findFirst({
        where: {
          status: 'success',
          OR: [{ source: `${base}:${studentGuid}` }, { source: base }],
        },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, endedAt: true },
      });
      const at = run?.endedAt ?? run?.startedAt ?? null;
      // No successful run on record at all is not treated as stale: a brand-new
      // deployment would otherwise report every child as stale on day one.
      if (at === null) continue;
      if (oldest === null || at < oldest) oldest = at;
    }

    return oldest !== null && oldest < cutoff ? oldest : null;
  }

  private async recordEmpty(
    userId: string,
    studentGuid: string,
    reportFor: Date,
    reason: string,
  ): Promise<DigestRunResult> {
    this.logger.log(`Digest ${studentGuid}: ${reason}; nothing sent.`);
    return this.record(userId, studentGuid, reportFor, {
      status: 'skipped_empty',
      itemCount: 0,
      recipientCount: 0,
      usedLlm: false,
    });
  }

  /**
   * Every run writes a row, `skipped_empty` included. It is the only way to
   * tell a quiet child from a broken job, and GET /digest/deliveries is what
   * exposes that.
   */
  private async record(
    userId: string,
    studentGuid: string,
    reportFor: Date,
    fields: {
      status: DigestRunStatus;
      itemCount: number;
      recipientCount: number;
      usedLlm: boolean;
      messageText?: string;
      channel?: string | null;
      errorMessage?: string;
    },
  ): Promise<DigestRunResult> {
    await this.prisma.digestDelivery.create({
      data: {
        userId,
        studentGuid,
        reportFor,
        status: fields.status,
        itemCount: fields.itemCount,
        recipientCount: fields.recipientCount,
        usedLlm: fields.usedLlm,
        messageText: fields.messageText ?? null,
        channel: fields.channel ?? null,
        errorMessage: fields.errorMessage ?? null,
      },
    });

    return {
      studentGuid,
      userId,
      status: fields.status,
      itemCount: fields.itemCount,
      recipientCount: fields.recipientCount,
      usedLlm: fields.usedLlm,
      ...(fields.errorMessage ? { error: fields.errorMessage } : {}),
    };
  }

  private readDays(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private timeZone(): string {
    return this.config.get<string>('DIGEST_TIMEZONE') ?? DEFAULT_TIMEZONE;
  }

  private isEnabledByConfig(): boolean {
    return String(this.config.get<string | boolean>('DIGEST_ENABLED') ?? 'false')
      .trim()
      .toLowerCase() === 'true';
  }

  /** Defaults to true: a first deploy must not message a parent by accident. */
  private isDryRunByDefault(): boolean {
    const raw = this.config.get<string | boolean>('DIGEST_DRY_RUN');
    if (raw === undefined || raw === null || raw === '') return true;
    return String(raw).trim().toLowerCase() !== 'false';
  }
}

/**
 * Which prose to render.
 *
 * The model writes its sentences from the un-narrowed payload, because the
 * deadline resolution it returns is what *does* the narrowing. So when
 * narrowing removes a due item, the model's `dueTomorrowLine` describes items
 * the bullets no longer list -- "two assignments due tomorrow, in history and
 * maths" above a single maths bullet -- and can even name a date for an item
 * that was deliberately deferred. In that case only that line is replaced with
 * the deterministic one, which counts what actually survived.
 */
function linesFor(summary: DigestSummary, before: DigestPayload, after: DigestPayload) {
  const fallback = deterministicLines(after);
  if (!summary.usedLlm) return fallback;

  const lines = { ...summary.lines };

  // The headline is written from the un-narrowed payload too, and can state a
  // count or name a subject that no longer survived -- the same defect the
  // dueTomorrowLine swap exists to fix. Once the set has changed underneath the
  // model, every line it wrote about that set is suspect.
  if (after.homeworkDueTomorrow.length !== before.homeworkDueTomorrow.length) {
    lines.headline = fallback.headline;
    lines.dueTomorrowLine = fallback.dueTomorrowLine;
  }

  // The report has no item bullets, so a section's prose is the only place its
  // facts appear. A blank line for a section that *has* items would drop that
  // news from the message while the ledger still recorded it as reported --
  // meaning it would never be mentioned again. The deterministic sentence is
  // plainer than the model's and complete, which is the right trade here.
  // The model is handed no consent forms at all, so its line about them -- if
  // it writes one anyway -- describes nothing. Replaced outright rather than
  // only when blank, which is all the loop below would do.
  lines.activityLine = fallback.activityLine;

  const sections = [
    ['behaviorLine', after.behavior.length],
    ['homeworkLine', after.homeworkNew.length],
    ['dueTomorrowLine', after.homeworkDueTomorrow.length],
    ['releaseLine', after.releases.length],
  ] as const;

  for (const [key, itemCount] of sections) {
    if (itemCount > 0 && lines[key].trim().length === 0) {
      lines[key] = fallback[key];
    }
  }

  if (lines.headline.trim().length === 0) lines.headline = fallback.headline;

  return lines;
}

/**
 * Applies the model's deadline reading to the due-tomorrow section.
 *
 * Resolution order is explicit-from-text over timetable estimate (ADR-0027).
 * An item whose resolved deadline is not tomorrow leaves the section: the
 * checker deliberately over-collects on a text hint so the model can find a
 * deadline the timetable would have missed, and this is where that set is
 * narrowed again. The resolutions are returned so the caller can record them
 * and avoid asking the same question again.
 */
function narrowDueTomorrow(
  payload: DigestPayload,
  summary: DigestSummary,
  tomorrowStart: Date,
): { payload: DigestPayload; resolutionByItemId: Map<string, Date | null> } {
  const explicitByRef = new Map(
    summary.deadlineResolutions.map((resolution) => [resolution.ref, resolution.explicitDueDate]),
  );

  const kept: DigestHomeworkFact[] = [];
  const resolutionByItemId = new Map<string, Date | null>();

  for (const item of payload.homeworkDueTomorrow) {
    const explicit = parseIsoDate(explicitByRef.get(item.id) ?? null);
    const resolved = explicit ?? item.estimatedDueDate ?? null;
    resolutionByItemId.set(item.id, resolved);
    if (resolved === null) continue;
    if (resolved.getTime() !== tomorrowStart.getTime()) continue;
    kept.push({ ...item, estimatedDueDate: resolved });
  }

  return { payload: { ...payload, homeworkDueTomorrow: kept }, resolutionByItemId };
}

/**
 * The hashes of claims that made it into the rendered report.
 *
 * Keyed on itemType plus itemId rather than on the payload alone, because the
 * same homework row can be claimed twice -- once as newly assigned and once as
 * estimated-due -- and only one of those may have survived. It also drops
 * claims whose underlying row vanished upstream between the check and the
 * collect, which the collector silently omits from the payload.
 */
function survivingHashes(claimed: DigestCandidate[], narrowed: DigestPayload): Set<string> {
  const alive = new Set<string>([
    ...narrowed.behavior.map((fact) => `behavior:${fact.id}`),
    ...narrowed.homeworkNew.map((fact) => `homework_new:${fact.id}`),
    ...narrowed.homeworkDueTomorrow.map((fact) => `homework_due:${fact.id}`),
    ...narrowed.releases.map((fact) => `release:${fact.id}`),
    ...narrowed.activities.map((fact) => `activity:${fact.id}`),
  ]);

  return new Set(
    claimed
      .filter((candidate) => alive.has(`${candidate.itemType}:${candidate.itemId}`))
      .map((candidate) => candidate.contentHash),
  );
}

/** Parses YYYY-MM-DD into UTC midnight, the digest's only date representation. */
function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Distinct items in the report. A homework row reported both as newly assigned
 * and as estimated-due is one item to a parent reading the message, so it is
 * counted once.
 */
function countItems(payload: DigestPayload): number {
  const ids = new Set<string>([
    ...payload.behavior.map((fact) => `behavior:${fact.id}`),
    ...payload.homeworkNew.map((fact) => `homework:${fact.id}`),
    ...payload.homeworkDueTomorrow.map((fact) => `homework:${fact.id}`),
    ...payload.releases.map((fact) => `release:${fact.id}`),
    ...payload.activities.map((fact) => `activity:${fact.id}`),
  ]);
  return ids.size;
}

/**
 * What goes in the delivery row's `errorMessage`.
 *
 * Partial send failures and suppressions share the column because both are
 * "the row says sent, and here is the asterisk".
 */
function deliveryNote(failures: string[], suppressed: number): string | undefined {
  const notes = [...failures];
  if (suppressed > 0) {
    notes.push(
      `suppressed ${suppressed} duplicate send(s): an identical message had already gone to that chat in this run`,
    );
  }
  return notes.length > 0 ? notes.join('; ') : undefined;
}
