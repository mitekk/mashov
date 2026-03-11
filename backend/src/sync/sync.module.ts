import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionModule } from '../session/session.module';
import { SyncRunService } from './sync-run.service';
import { BehaviorClassifierService } from './behavior-classifier.service';
import { FreshnessService } from './freshness.service';
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

@Module({
  imports: [PrismaModule, SessionModule],
  controllers: [SyncController],
  providers: [
    SyncRunService,
    BehaviorClassifierService,
    FreshnessService,
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
  ],
  exports: [SyncRunService, BehaviorClassifierService, FreshnessService, SyncService],
})
export class SyncModule {}
