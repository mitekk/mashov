import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { DigestCheckerService, STALE_CLAIM_MS } from './digest-checker.service';
import { DigestCollectorService } from './digest-collector.service';
import { DigestSummarizerService } from './digest-summarizer.service';
import {
  DigestRecipientService,
  DigestDeliveryTarget,
  DigestSkippedTarget,
} from './digest-recipient.service';
import { DigestSender } from './senders/digest-sender.interface';
import { TelegramSender } from './senders/telegram.sender';
import { LogSender } from './senders/log.sender';
import { jerusalemClockMinutes, jerusalemDayBounds } from './digest-deadline.service';
import { DigestDismissalService, DismissalGate } from './digest-dismissal.service';
import { isPermanentTelegramFailure } from '../telegram/telegram-http';
import { resolvePublicBaseUrl } from '../telegram/public-base-url';
import { deterministicLines, renderReport } from './digest-report.template';
import { DigestCandidate, DigestHomeworkFact, DigestPayload, DigestSummary } from './digest.types';
import { DigestAttachment, DigestAttachmentResolver } from './digest-attachment.resolver';
import {
  FetchedMedia,
  MEDIA_DELIVERY,
  MediaAttachmentRef,
  MediaDelivery,
  NO_MEDIA_DELIVERY,
} from '../telegram-media/media-delivery.interface';

/**
 * The claimed hashes a child's prose is written from, sorted.
 *
 * Activity hashes are excluded because they embed the owning `userId`, so two
 * parents' claims for the same form hash differently -- and the forms are not
 * in the summarizer's payload anyway. Every other hash is derived from the
 * child's own row, which is what makes an equal list mean an equal payload
 * for the fields the model is shown. (`childFirstName`, `childGender` and the
 * timetable estimates are re-read per target and are not in any hash; two
 * targets of one child are seconds apart, so the only way they could diverge
 * is a row edited mid-run, and the shared summary then carries the first
 * reading of it.)
 *
 * An empty list means there is nothing for the model to write about.
 */
function nonActivityHashes(claimed: DigestCandidate[]): string[] {
  return claimed
    .filter((candidate) => candidate.itemType !== 'activity')
    .map((candidate) => candidate.contentHash)
    .sort();
}

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

/**
 * How stale the school data may be before a quiet day stops being reported as
 * quiet.
 *
 * The original reasoning -- "the sync tasks run every 12 minutes, so six hours
 * means several dozen consecutive failures" -- no longer holds: those crons are
 * gone. The guarantee now comes from `NotificationWindowTask`'s digest-lead
 * tick, which fetches at :50 before each 11:00-19:00 digest tick, so a
 * successful `homework`/`behavior` run is minutes old at every tick rather than
 * hours. Six hours is now slack, not a tight bound.
 *
 * **Exported so the regression test reads the real value.** A copy in the test
 * would drift, and the test would stay green while the trip-wire broke. Push
 * the lead tick out past this and every quiet child flips from
 * `skipped_empty` to `skipped_stale`, permanently and silently.
 */
export const SYNC_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

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

export type DigestRunStatus =
  | 'sent'
  | 'skipped_empty'
  | 'skipped_stale'
  /**
   * The child is still at school: held until their last lesson has ended plus
   * the grace period (ADR-0040). A hold claims nothing and writes no delivery
   * row, so the next tick reports everything this one would have.
   */
  | 'skipped_before_dismissal'
  /** The send-time ownership guard refused the (child, parent) pair. */
  | 'skipped_unowned'
  | 'failed'
  | 'dry_run';

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
  /**
   * Sends without waiting for the child's last bell. Set by the manual-run
   * endpoint: a parent pressing the button is asking for the digest now, and
   * the gate exists to stop unattended noise rather than to refuse an explicit
   * request.
   */
  ignoreDismissalGate?: boolean;
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
    private readonly dismissal: DigestDismissalService,
    // Typed as the interface, injected by concrete class: the channel is meant
    // to be a configuration detail, and the orchestrator should not know how
    // either sender works.
    @Inject(TelegramSender) telegram: DigestSender,
    @Inject(LogSender) private readonly logSender: DigestSender,
    private readonly attachments: DigestAttachmentResolver,
    // `@Optional()` so DigestModule still compiles on its own, which is how
    // digest.module.spec.ts proves the Mashov client is unreachable from this
    // graph. See src/telegram-media/telegram-media.module.ts.
    @Optional() @Inject(MEDIA_DELIVERY) media?: MediaDelivery,
  ) {
    this.senders = [telegram, logSender];
    this.media = media ?? NO_MEDIA_DELIVERY;
  }

  private readonly media: MediaDelivery;

  async runAll(options: DigestRunOptions = {}): Promise<DigestRunResult[]> {
    if (this.running) {
      this.logger.warn('A digest run is already in flight; skipping this tick.');
      return [];
    }
    this.running = true;

    try {
      const now = options.now ?? new Date();
      const dryRun = options.dryRun ?? this.isDryRunByDefault();

      const named = <T extends { studentGuid: string }>(rows: T[]): T[] =>
        options.studentGuid
          ? rows.filter((row) => row.studentGuid === options.studentGuid)
          : rows;

      const listed = await this.recipients.listDeliveryTargets(options.userId);
      const targets = named(listed.targets);
      const skipped = named(listed.skipped);

      if (targets.length === 0 && skipped.length === 0) return [];

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

      // One clock reading for the whole tick, so every child in a run is
      // judged against the same minute -- a run that takes four minutes must
      // not release the last child on a later clock than the first.
      const nowMinutes = jerusalemClockMinutes(now, this.timeZone());

      // When each child may be sent, memoized like `staleness` and for the
      // same reason: two parents of one child ask the same question. Per run
      // rather than between runs, so a timetable sync that lands mid-morning
      // is picked up by the next tick.
      const gates = new Map<string, DismissalGate>();

      // One model call per child per run, as before this became per-parent.
      // Keyed on the child and the non-activity content hashes it claimed:
      // those hashes are userId-independent by construction, so an equal key
      // means an equal payload. Per run, so a change between runs is seen.
      const summaries = new Map<string, DigestSummary>();

      const results: DigestRunResult[] = [];

      // The refusals first, so a parent whose digest has stopped sees a row
      // for it in the same history as everything else.
      for (const refused of skipped) {
        results.push(await this.recordRefused(refused, now));
      }

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
            nowMinutes,
            dryRun,
            options,
            staleness,
            gates,
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
    nowMinutes: number,
    dryRun: boolean,
    options: DigestRunOptions,
    staleness: Map<string, Date | null>,
    gates: Map<string, DismissalGate>,
    alreadySent: Set<string>,
    summaries: Map<string, DigestSummary>,
  ): Promise<DigestRunResult> {
    const { studentGuid, userId } = target;
    const { tomorrowStart, reportFor: defaultReportFor } = jerusalemDayBounds(now, this.timeZone());
    const runId = randomUUID();
    let reportFor = defaultReportFor;
    let claimed: DigestCandidate[] = [];

    try {
      // Before the checker, and above all before `claim()`. A held tick must
      // consume nothing: if it claimed, the items would be marked reported and
      // the post-dismissal tick would find a quiet day, turning a delay into
      // permanent suppression. It also writes no digest_delivery row -- the
      // hold is a scheduling decision, not an outcome (ADR-0040).
      if (!options.ignoreDismissalGate) {
        const gate = await this.dismissalGate(studentGuid, schoolYear, defaultReportFor, gates);
        if (gate.releaseAtMinutes !== null && nowMinutes < gate.releaseAtMinutes) {
          this.logger.debug(
            `Digest ${studentGuid}: holding until ${formatClock(gate.releaseAtMinutes)} ` +
              `(last lesson ${gate.lastLesson} ends ${gate.lastLessonEnd}, ${gate.source} schedule).`,
          );
          return {
            studentGuid,
            userId,
            status: 'skipped_before_dismissal',
            itemCount: 0,
            recipientCount: 0,
            usedLlm: false,
          };
        }
      }

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
      const summary = await this.summaryFor(studentGuid, claimed, payload, summaries);
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

      // Downloaded BEFORE the text is rendered, because no size is known
      // anywhere until the bytes arrive and the text has to name what it is
      // not sending. Skipped entirely on a dry run and when the media binding
      // is the no-op, so neither pays for the reads.
      const media = dryRun ? NO_FETCH : await this.fetchMedia(userId, studentGuid, surviving, claimed);

      const message = renderReport(narrowed, lines, {
        publicBaseUrl: resolvePublicBaseUrl(this.config.get<string>('PUBLIC_BASE_URL')),
        unsentFileNames: media.items.filter((item) => item.tooLarge).map((item) => item.ref.fileName),
      });

      const { delivered, failures, suppressed, retired, reached } = await this.deliver(
        studentGuid,
        enabled,
        message,
        dryRun,
        alreadySent,
      );

      await this.retireRecipients(userId, studentGuid, retired);

      // The throw is suppressed only when EVERY failure was permanent.
      //
      // Throwing releases the claims, which is right for a transient failure
      // and wrong for a permanent one: the items would come back on every run,
      // with a fresh model call each time, for chats that have just been
      // disabled. But `retired.length > 0` was the wrong test. With one
      // blocked chat and one chat answering 502, it confirmed the claims and
      // buried the day's news for the chat that was merely flaky -- and
      // permanently, because nothing ever re-reports an item already in the
      // ledger. Comparing the counts makes a mixed outcome retry, which is
      // what the live chat needs.
      const everyFailurePermanent = retired.length > 0 && retired.length === failures.length;
      if (delivered === 0 && enabled.length > 0 && !everyFailurePermanent) {
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

      // After the text, and only to the chats the text actually reached. A
      // failed upload is a note and never a throw, so it can neither fail nor
      // re-queue the report -- the text remains the only thing gating the
      // ledger.
      const mediaNotes = [...media.notes];
      for (const address of reached) {
        const result = await this.media.send(address, media.items);
        mediaNotes.push(...result.notes);
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
        status: delivered > 0 ? 'sent' : 'failed',
        itemCount,
        // Chats actually reached. A suppression counts as delivered for the
        // guard above -- otherwise a suppressed-only run throws, releases its
        // claims and retries the same suppressed send every hour -- but it is
        // not a recipient reached, and `recipientCount` is what the delivery
        // stats aggregate.
        recipientCount: delivered - suppressed,
        usedLlm: summary.usedLlm,
        messageText: message,
        channel: enabled[0]?.channel ?? null,
        // A partial failure is recorded but does not undo a real delivery.
        // The suppression note rides on the same field, so support can tell
        // "sent" from "the other parent's run sent this exact text already".
        errorMessage: deliveryNote(failures, suppressed, mediaNotes),
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

  /** The child's release time, asked once per child per run. */
  private async dismissalGate(
    studentGuid: string,
    schoolYear: number,
    todayStart: Date,
    gates: Map<string, DismissalGate>,
  ): Promise<DismissalGate> {
    const memoed = gates.get(studentGuid);
    if (memoed) return memoed;

    const gate = await this.dismissal.gateFor(studentGuid, schoolYear, todayStart);
    gates.set(studentGuid, gate);
    return gate;
  }

  /**
   * Writes the stop of a target the send-time ownership guard refused.
   *
   * Once per school day per (child, parent), not once per run: the cron runs
   * seven times a day and a retired child's stale recipient row never stops
   * being refused, so an unconditional write would bury the history this
   * exists to make readable under 630 identical rows before the retention
   * sweep reached them.
   *
   * The result is returned either way, so a manual run always says what
   * happened even when the row was written by an earlier run today.
   */
  private async recordRefused(
    refused: DigestSkippedTarget,
    now: Date,
  ): Promise<DigestRunResult> {
    const { reportFor } = jerusalemDayBounds(now, this.timeZone());
    const fields = {
      status: 'skipped_unowned' as const,
      itemCount: 0,
      recipientCount: 0,
      usedLlm: false,
      errorMessage: refused.reason,
    };

    const alreadyRecorded = await this.prisma.digestDelivery.findFirst({
      where: {
        userId: refused.userId,
        studentGuid: refused.studentGuid,
        reportFor,
        status: 'skipped_unowned',
      },
      select: { id: true },
    });

    if (alreadyRecorded) {
      return {
        studentGuid: refused.studentGuid,
        userId: refused.userId,
        ...fields,
        error: refused.reason,
      };
    }

    return this.record(refused.userId, refused.studentGuid, reportFor, fields);
  }

  /**
   * The prose for this run: the model's, or the deterministic renderer's.
   *
   * Two things happen here. A run whose only claims are consent forms never
   * reaches the model at all -- the forms are withheld from its payload, so
   * the prompt would carry no facts beyond the child's gender and the date,
   * and a headline written from nothing is a headline invented. And a run for
   * a child another parent's run has already summarized in this pass reuses
   * that summary rather than paying for an identical one.
   */
  private async summaryFor(
    studentGuid: string,
    claimed: DigestCandidate[],
    payload: DigestPayload,
    summaries: Map<string, DigestSummary>,
  ): Promise<DigestSummary> {
    const hashes = nonActivityHashes(claimed);
    if (hashes.length === 0) {
      return { lines: deterministicLines(payload), deadlineResolutions: [], usedLlm: false };
    }

    const key = `${studentGuid}\u0000${hashes.join('|')}`;
    const memoed = summaries.get(key);
    if (memoed) return memoed;

    const summary = await this.summarizer.summarize({ ...payload, activities: [] });
    summaries.set(key, summary);
    return summary;
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
    studentGuid: string,
    recipients: { channel: string; address: string }[],
    message: string,
    dryRun: boolean,
    alreadySent: Set<string>,
  ): Promise<{
    delivered: number;
    failures: string[];
    suppressed: number;
    /** Chats Telegram says will never accept another message. */
    retired: { channel: string; address: string; reason: string }[];
    /**
     * The addresses the text actually reached, so the files follow it to
     * exactly those chats -- a chat whose text failed must get no files.
     */
    reached: string[];
  }> {
    let delivered = 0;
    let suppressed = 0;
    const failures: string[] = [];
    const retired: { channel: string; address: string; reason: string }[] = [];
    const reached: string[] = [];
    const digest = createHash('sha256').update(message).digest('hex');

    for (const recipient of recipients) {
      // Per child as well as per chat. Two children whose messages render
      // identically -- two studentGuids for the same child, which a
      // re-enrolment or two schools listing them both produce -- would
      // otherwise have the second one's send suppressed and its claims
      // confirmed, losing that child's news for good.
      const fingerprint = `${recipient.channel}\u0000${recipient.address}\u0000${studentGuid}\u0000${digest}`;
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
        if (!dryRun) reached.push(recipient.address);
        alreadySent.add(fingerprint);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Digest delivery to ${recipient.channel} failed: ${reason}`);
        failures.push(reason);
        // A blocked bot or a deleted chat is not worth retrying: the items
        // would be re-claimed, re-summarized and re-sent on every run forever.
        // The caller confirms the claims anyway and disables the row.
        if (!dryRun && isPermanentTelegramFailure(reason)) {
          retired.push({ channel: recipient.channel, address: recipient.address, reason });
        }
      }
    }

    return { delivered, failures, suppressed, retired, reached };
  }

  /**
   * The files on the items this run is about to report, downloaded.
   *
   * Only the SURVIVING claims: an item narrowing removed is not in the
   * message, so its attachment has nothing to be a caption for. The
   * attachment metadata reaches this through DigestAttachmentResolver rather
   * than through DigestPayload -- that object feeds buildPrompt, and a
   * behaviour row's rawPayload carries the reporter's name and the child's
   * guid. See ADR-0026 and ADR-0039.
   */
  private async fetchMedia(
    userId: string,
    studentGuid: string,
    surviving: Set<string>,
    claimed: DigestCandidate[],
  ): Promise<{ items: FetchedMedia[]; notes: string[] }> {
    if (!this.media.enabled) return NO_FETCH;

    const sent = claimed.filter((candidate) => surviving.has(candidate.contentHash));
    if (sent.length === 0) return NO_FETCH;

    const refs = (await this.attachments.resolve(studentGuid, sent)).map(mediaRefFor);
    if (refs.length === 0) return NO_FETCH;

    const fetched = await this.media.fetch(userId, refs, this.media.budgetBytes());
    return {
      items: fetched.items,
      notes: fetched.items
        .map((item) => item.note)
        .filter((note): note is string => typeof note === 'string' && note.length > 0),
    };
  }

  /**
   * Stops sending to a chat Telegram has refused permanently.
   *
   * Scoped to the (child, parent) row rather than the address alone: the same
   * family group chat can be linked by two parents and for several children,
   * and the refusal this run saw was for this subscription.
   */
  private async retireRecipients(
    userId: string,
    studentGuid: string,
    retired: { channel: string; address: string; reason: string }[],
  ): Promise<void> {
    for (const recipient of retired) {
      this.logger.warn(
        `Disabling digest recipient ${recipient.channel}/${recipient.address} for ${studentGuid}: ${recipient.reason}`,
      );
      await this.prisma.digestRecipient.updateMany({
        where: {
          userId,
          studentGuid,
          channel: recipient.channel,
          address: recipient.address,
        },
        data: { enabled: false },
      });
    }
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

/** Minutes since midnight as a wall clock, for the hold's debug line. */
function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
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
    // Counted per section, not per list: the behaviour list feeds two sections
    // now, and a blank positiveLine on a day with praise would drop it.
    ['behaviorLine', after.behavior.filter((fact) => fact.classification !== 'positive').length],
    ['positiveLine', after.behavior.filter((fact) => fact.classification === 'positive').length],
    ['homeworkLine', after.homeworkNew.length],
    ['dueTomorrowLine', after.homeworkDueTomorrow.length],
    ['releaseLine', after.releases.length],
    ['boardLine', after.board.length],
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
    ...narrowed.board.map((fact) => `message_board:${fact.id}`),
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
    ...payload.board.map((fact) => `board:${fact.id}`),
  ]);
  return ids.size;
}

/**
 * What goes in the delivery row's `errorMessage`.
 *
 * Partial send failures and suppressions share the column because both are
 * "the row says sent, and here is the asterisk".
 */
function deliveryNote(
  failures: string[],
  suppressed: number,
  mediaNotes: string[] = [],
): string | undefined {
  const notes = [...failures, ...mediaNotes];
  if (suppressed > 0) {
    notes.push(
      `suppressed ${suppressed} duplicate send(s): an identical message had already gone to that chat in this run`,
    );
  }
  return notes.length > 0 ? notes.join('; ') : undefined;
}

/** Nothing fetched, nothing to say about it. */
const NO_FETCH: { items: FetchedMedia[]; notes: string[] } = { items: [], notes: [] };

/**
 * One attachment as the media layer wants it.
 *
 * The caption is the file name alone. It could carry the subject, but the
 * report is already headed by the child and the date, the caption cannot be
 * chunked, and a name is what tells a parent which of three files they are
 * looking at.
 */
function mediaRefFor(attachment: DigestAttachment): MediaAttachmentRef {
  return {
    kind: attachment.itemType,
    ownerId: attachment.studentGuid,
    itemId: attachment.itemId,
    fileId: attachment.fileId,
    fileName: attachment.fileName,
    caption: attachment.fileName,
  };
}
