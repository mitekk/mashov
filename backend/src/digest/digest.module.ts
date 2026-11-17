import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { DigestService } from './digest.service';
import { DigestCheckerService } from './digest-checker.service';
import { DigestCollectorService } from './digest-collector.service';
import { DigestDeadlineService } from './digest-deadline.service';
import { DigestSummarizerService } from './digest-summarizer.service';
import { DigestRecipientService } from './digest-recipient.service';
import { TelegramSender } from './senders/telegram.sender';
import { LogSender } from './senders/log.sender';
import { DigestTask } from './tasks/digest.task';
import { DigestController } from './digest.controller';

/**
 * A sibling of SyncModule, not a task inside it. A digest is not a sync
 * source: it reads local Postgres and egresses to third parties.
 *
 * It deliberately imports neither MashovSessionModule nor anything that builds
 * a Mashov axios client. ADR-0023's egress hop is a single residential
 * tinyproxy with a 10s AbortSignal and no retry-on-abort, and HTTPS_PROXY is
 * process-wide, so parent messages and model prompts must never be able to
 * reach it. SchoolYearModule is imported for SchoolYearService, which is used
 * only through its DB-only currentSchoolYearFor().
 *
 * BehaviorClassifierService is not needed: BehaviorItem.classification is
 * already persisted by the sync tasks, so the digest reads it rather than
 * recomputing it -- which also keeps SyncModule out of the dependency graph.
 */
@Module({
  imports: [PrismaModule, SchoolYearModule],
  controllers: [DigestController],
  providers: [
    DigestService,
    DigestCheckerService,
    DigestCollectorService,
    DigestDeadlineService,
    DigestSummarizerService,
    DigestRecipientService,
    TelegramSender,
    LogSender,
    DigestTask,
  ],
  exports: [DigestService, DigestRecipientService],
})
export class DigestModule {}
