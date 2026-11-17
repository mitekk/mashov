import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { DigestCheckerService } from './digest-checker.service';
import { DigestCollectorService } from './digest-collector.service';
import { DigestSummarizerService } from './digest-summarizer.service';
import { DigestRecipientService, DigestDeliveryTarget } from './digest-recipient.service';
import { DigestSender } from './senders/digest-sender.interface';
import { TelegramSender } from './senders/telegram.sender';
import { LogSender } from './senders/log.sender';
import { jerusalemDayBounds } from './digest-deadline.service';
import { deterministicLines, renderReport } from './digest-report.template';
import { DigestCandidate, DigestHomeworkFact, DigestPayload, DigestSummary } from './digest.types';

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

export type DigestRunStatus = 'sent' | 'skipped_empty' | 'failed' | 'dry_run';

export interface DigestRunResult {
  studentGuid: string;
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
}

/**
 * Orchestrates one digest run: enumerate the opted-in children, check, claim,
 * collect, summarize, send, confirm.
 *
 * Correctness under concurrency comes from the Postgres unique constraint on
 * `digest_reported_item`, following the `fingerprint` precedent in
 * notifications.task.ts. RedisService has no SET NX, no Lua and no raw client,
 * and ADR-0017 forbids durable state there, so there is no lock to take.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  /**
   * In-process guard so a slow run never overlaps itself -- the hourly cron
   * would otherwise start a second pass over the same children while the first
   * is still waiting on a model or on Telegram. Precedent:
   * inFlightManualRefreshByConnection in sync.service.ts.
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

      const allTargets = await this.recipients.listDeliveryTargets();
      const targets = options.studentGuid
        ? allTargets.filter((target) => target.studentGuid === options.studentGuid)
        : allTargets;

      if (targets.length === 0) return [];

      // Resolved once per run, not per child: currentSchoolYearFor is DB-only,
      // but it is still a query, and every child in a household shares it.
      // Never resolveForSchool() -- that calls /api/schools through the Mashov
      // residential proxy, which this module must never touch.
      const schoolYear = await this.schoolYear.currentSchoolYearFor();

      const results: DigestRunResult[] = [];
      for (const target of targets) {
        // Per-child isolation, as homework.task.ts does: one child's model or
        // Telegram failure must not stop the others.
        results.push(await this.runForChild(target, schoolYear, now, dryRun));
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
  ): Promise<DigestRunResult> {
    const { studentGuid } = target;
    const { tomorrowStart } = jerusalemDayBounds(now, this.timeZone());
    let reportFor = jerusalemDayBounds(now, this.timeZone()).reportFor;
    let claimed: DigestCandidate[] = [];

    try {
      const check = await this.checker.check({
        studentGuid,
        schoolYear,
        now,
        activeFrom: target.activeFrom,
      });
      reportFor = check.reportFor;

      if (check.candidates.length === 0) {
        return await this.recordEmpty(studentGuid, reportFor, 'nothing unreported');
      }

      // Claim first. The unique constraint is the lock: skipDuplicates means a
      // row that already exists is someone else's, and a count of zero means
      // every item is already spoken for.
      const claimResult = await this.prisma.digestReportedItem.createMany({
        data: check.candidates.map((candidate) => ({
          studentGuid,
          itemType: candidate.itemType,
          itemId: candidate.itemId,
          contentHash: candidate.contentHash,
          reportedFor: reportFor,
        })),
        skipDuplicates: true,
      });

      if (claimResult.count === 0) {
        this.logger.log(
          `Digest ${studentGuid}: another runner already owns every item; sending nothing.`,
        );
        return await this.recordEmpty(studentGuid, reportFor, 'already claimed elsewhere');
      }
      claimed = check.candidates;

      const payload = await this.collector.collect({
        studentGuid,
        candidates: check.candidates,
        reportFor,
      });

      const summary = await this.summarizer.summarize(payload);
      const narrowed = narrowDueTomorrow(payload, summary, tomorrowStart);

      if (isEmptyReport(narrowed)) {
        // Everything the checker widened in turned out not to be due tomorrow.
        // Release the claims rather than confirm them -- see releaseClaims.
        await this.releaseClaims(studentGuid, claimed);
        return await this.recordEmpty(
          studentGuid,
          reportFor,
          'no item survived deadline resolution',
        );
      }

      const lines = summary.usedLlm ? summary.lines : deterministicLines(narrowed);
      const message = renderReport(narrowed, lines);

      const enabled = (
        await this.prisma.digestRecipient.findMany({
          where: { studentGuid, enabled: true },
          select: { channel: true, address: true, enabled: true },
        })
      ).filter((recipient) => recipient.enabled);

      for (const recipient of enabled) {
        const sender = dryRun ? this.logSender : this.senderFor(recipient.channel);
        await sender.send(recipient.address, message);
      }

      const itemCount = countItems(narrowed);

      if (dryRun) {
        // A dry run must not mark anything reported, or the first real run
        // would find nothing left to say.
        await this.releaseClaims(studentGuid, claimed);
        return await this.record(studentGuid, reportFor, {
          status: 'dry_run',
          itemCount,
          recipientCount: enabled.length,
          usedLlm: summary.usedLlm,
          messageText: message,
          channel: this.logSender.channel,
        });
      }

      await this.confirmClaims(studentGuid, claimed, reportFor);

      return await this.record(studentGuid, reportFor, {
        status: 'sent',
        itemCount,
        recipientCount: enabled.length,
        usedLlm: summary.usedLlm,
        messageText: message,
        channel: enabled[0]?.channel ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Digest failed for ${studentGuid}: ${message}`);

      // Roll the claim back so the next hourly run retries. A crash before
      // this point leaves the rows unconfirmed, which the checker's 30-minute
      // staleness rule reclaims, so nothing is silently lost either way.
      if (claimed.length > 0) {
        await this.releaseClaims(studentGuid, claimed).catch(() => undefined);
      }

      return await this.record(studentGuid, reportFor, {
        status: 'failed',
        itemCount: 0,
        recipientCount: 0,
        usedLlm: false,
        errorMessage: message,
      });
    }
  }

  private senderFor(channel: string): DigestSender {
    const sender = this.senders.find((candidate) => candidate.channel === channel);
    if (!sender) throw new Error(`No digest sender for channel "${channel}".`);
    return sender;
  }

  private async confirmClaims(
    studentGuid: string,
    claimed: DigestCandidate[],
    reportFor: Date,
  ): Promise<void> {
    await this.prisma.digestReportedItem.updateMany({
      where: { studentGuid, contentHash: { in: claimed.map((c) => c.contentHash) }, reportedFor: reportFor },
      data: { confirmedAt: new Date() },
    });
  }

  /**
   * Deletes claims rather than confirming them.
   *
   * Used when nothing was delivered: a dry run, a failed send, or an item the
   * model resolved to a deadline that is not tomorrow. Deleting is what lets a
   * deferred deadline be reported on the day it is actually near -- a confirmed
   * claim would mean that on Wednesday, when a Thursday deadline really is
   * tomorrow, the item counts as already reported and the parent never hears
   * about it.
   */
  private async releaseClaims(studentGuid: string, claimed: DigestCandidate[]): Promise<void> {
    await this.prisma.digestReportedItem.deleteMany({
      where: {
        studentGuid,
        contentHash: { in: claimed.map((candidate) => candidate.contentHash) },
        confirmedAt: null,
      },
    });
  }

  private async recordEmpty(
    studentGuid: string,
    reportFor: Date,
    reason: string,
  ): Promise<DigestRunResult> {
    this.logger.log(`Digest ${studentGuid}: ${reason}; nothing sent.`);
    return this.record(studentGuid, reportFor, {
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
      status: fields.status,
      itemCount: fields.itemCount,
      recipientCount: fields.recipientCount,
      usedLlm: fields.usedLlm,
      ...(fields.errorMessage ? { error: fields.errorMessage } : {}),
    };
  }

  private timeZone(): string {
    return this.config.get<string>('DIGEST_TIMEZONE') ?? DEFAULT_TIMEZONE;
  }

  /** Defaults to true: a first deploy must not message a parent by accident. */
  private isDryRunByDefault(): boolean {
    const raw = this.config.get<string | boolean>('DIGEST_DRY_RUN');
    if (raw === undefined || raw === null || raw === '') return true;
    return String(raw).trim().toLowerCase() !== 'false';
  }
}

/**
 * Applies the model's deadline reading to the due-tomorrow section.
 *
 * Resolution order is explicit-from-text over timetable estimate (ADR-0026).
 * An item whose resolved deadline is not tomorrow leaves the section: the
 * checker deliberately over-collects on a text hint so the model can find a
 * deadline the timetable would have missed, and this is where that set is
 * narrowed again.
 */
function narrowDueTomorrow(
  payload: DigestPayload,
  summary: DigestSummary,
  tomorrowStart: Date,
): DigestPayload {
  const explicitByRef = new Map(
    summary.deadlineResolutions.map((resolution) => [resolution.ref, resolution.explicitDueDate]),
  );

  const kept: DigestHomeworkFact[] = [];
  for (const item of payload.homeworkDueTomorrow) {
    const explicit = parseIsoDate(explicitByRef.get(item.id) ?? null);
    const resolved = explicit ?? item.estimatedDueDate ?? null;
    if (resolved === null) continue;
    if (resolved.getTime() !== tomorrowStart.getTime()) continue;
    kept.push({ ...item, estimatedDueDate: resolved });
  }

  return { ...payload, homeworkDueTomorrow: kept };
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

function countItems(payload: DigestPayload): number {
  return (
    payload.behavior.length + payload.homeworkNew.length + payload.homeworkDueTomorrow.length
  );
}

function isEmptyReport(payload: DigestPayload): boolean {
  return countItems(payload) === 0;
}
