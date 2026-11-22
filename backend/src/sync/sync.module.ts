import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { RedisModule } from '../redis/redis.module';
import { SyncRunService } from './sync-run.service';
import { BehaviorClassifierService } from './behavior-classifier.service';
import { FreshnessService } from './freshness.service';
import { SyncRunRetentionService } from './sync-run-retention.service';
import { RosterPresenceService } from './roster-presence.service';
import { RefreshProgressService } from './refresh-progress.service';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { NotificationsTask } from './tasks/notifications.task';
import { MailCountsTask } from './tasks/mail-counts.task';
import { MailInboxTask } from './tasks/mail-inbox.task';
import { HomeworkTask } from './tasks/homework.task';
import { BehaviorTask } from './tasks/behavior.task';
import { AchvasTask } from './tasks/achvas.task';
import { GroupsTask } from './tasks/groups.task';
import { LessonsCountTask } from './tasks/lessons-count.task';
import { MessageBoardTask } from './tasks/message-board.task';
import { UserDetailsTask } from './tasks/user-details.task';
import { DailyBehaveTask } from './tasks/daily-behave.task';
import { OutBehaveTask } from './tasks/out-behave.task';
import { ReleasesTask } from './tasks/releases.task';
import { SchoolActivitiesTask } from './tasks/school-activities.task';
import { TimetableTask } from './tasks/timetable.task';
import { BellsTask } from './tasks/bells.task';
import { StudentsTask } from './tasks/students.task';
import { SchoolYearRolloverTask } from './tasks/school-year-rollover.task';
import { HistoryBackfillTask } from './tasks/history-backfill.task';
import { SyncRunRetentionTask } from './tasks/sync-run-retention.task';

@Module({
  // RedisModule is @Global, but importing it here keeps SyncModule standalone:
  // RefreshProgressService needs RedisService, and a test harness that imports
  // SyncModule alone should not have to know that.
  imports: [ConfigModule, PrismaModule, MashovSessionModule, SchoolYearModule, RedisModule],
  controllers: [SyncController],
  providers: [
    SyncRunService,
    SyncRunRetentionService,
    RosterPresenceService,
    BehaviorClassifierService,
    FreshnessService,
    RefreshProgressService,
    SyncService,
    NotificationsTask,
    MailCountsTask,
    MailInboxTask,
    HomeworkTask,
    BehaviorTask,
    AchvasTask,
    GroupsTask,
    LessonsCountTask,
    MessageBoardTask,
    UserDetailsTask,
    DailyBehaveTask,
    OutBehaveTask,
    ReleasesTask,
    SchoolActivitiesTask,
    TimetableTask,
    BellsTask,
    StudentsTask,
    SchoolYearRolloverTask,
    HistoryBackfillTask,
    SyncRunRetentionTask,
  ],
  exports: [
    SyncRunService,
    SyncRunRetentionService,
    RosterPresenceService,
    RosterPresenceService,
    BehaviorClassifierService,
    FreshnessService,
    RefreshProgressService,
    SyncService,
  ],
})
export class SyncModule {}
