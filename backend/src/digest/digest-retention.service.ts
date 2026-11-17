import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long the digest keeps its own history. Long enough to answer "what did
 * you send my child's school data to, and when" for a term; short enough that
 * the dedup ledger does not grow without bound. messageText holds the text
 * actually sent to a parent, so keeping it forever would be its own problem.
 */
const RETENTION_DAYS = 90;

export interface DigestPruneResult {
  reportedItems: number;
  deliveries: number;
}

/**
 * Prunes the digest's own tables. Deliberately its own service rather than
 * folded into AppSessionService's 02:00 cleanup: that service is about auth
 * sessions, and the digest should not need a reason to be in its dependency
 * graph.
 */
@Injectable()
export class DigestRetentionService {
  private readonly logger = new Logger(DigestRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prune(now: Date = new Date()): Promise<DigestPruneResult> {
    // Both columns are @db.Date, so the cutoff is a date boundary rather than
    // a timestamp -- comparing against mid-day would be ambiguous about which
    // school day is the oldest one kept.
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RETENTION_DAYS),
    );

    // Independent deletes: one table failing must not leave the other growing
    // without bound until someone notices.
    const reportedItems = await this.deleteQuietly(
      'digest_reported_item',
      () => this.prisma.digestReportedItem.deleteMany({ where: { reportedFor: { lt: cutoff } } }),
    );
    const deliveries = await this.deleteQuietly(
      'digest_delivery',
      () => this.prisma.digestDelivery.deleteMany({ where: { reportFor: { lt: cutoff } } }),
    );

    if (reportedItems > 0 || deliveries > 0) {
      this.logger.log(
        `Pruned digest history older than ${RETENTION_DAYS} days: ` +
          `${reportedItems} reported items, ${deliveries} deliveries.`,
      );
    }

    return { reportedItems, deliveries };
  }

  private async deleteQuietly(
    table: string,
    run: () => Promise<{ count: number }>,
  ): Promise<number> {
    try {
      return (await run()).count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pruning ${table} failed: ${message}`);
      return 0;
    }
  }
}
