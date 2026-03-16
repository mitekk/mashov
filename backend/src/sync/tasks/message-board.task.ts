import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncTaskRunResult } from '../sync.types';
import sanitizeHtml = require('sanitize-html');

interface MashovMessageBoardItem {
  eventid: number;
  eventtext: string;
  font: string;
  color: string;
  expirationDate: string;
  inSite: boolean;
}

@Injectable()
export class MessageBoardTask {
  private readonly logger = new Logger(MessageBoardTask.name);
  public static readonly SOURCE = 'message_board';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('0 6 * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId: { not: null }, active: true },
    });
    const useSharedSession = connections.length === 0;
    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const student of students) {
      const source = `${MessageBoardTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let items: MashovMessageBoardItem[];
        const referer = 'https://web.mashov.info/students/main/dashboard';
        if (useSharedSession) {
          items = await this.mashovClient.get<MashovMessageBoardItem[]>(
            `/api/students/${student.studentGuid}/messageBoard`,
            { headers: { 'Referer': referer } },
          );
        } else {
          items = [];
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              items = await this.mashovClient.getForConnection<MashovMessageBoardItem[]>(
                `/api/students/${student.studentGuid}/messageBoard`,
                conn.id, conn.schoolCode, conn.schoolYear, conn.username, password,
                { headers: { 'Referer': referer } },
              );
              break;
            } catch { /* try next connection */ }
          }
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const sanitizedText = sanitizeHtml(item.eventtext, {
              allowedTags: sanitizeHtml.defaults.allowedTags.concat(['a', 'p', 'br', 'strong', 'em', 'span']),
              allowedAttributes: {
                'a': ['href', 'target', 'rel'],
                '*': [],
              },
            });

            const expirationDate = new Date(item.expirationDate);

            await this.prisma.messageBoardItem.upsert({
              where: {
                studentGuid_eventId: {
                  studentGuid: student.studentGuid,
                  eventId: item.eventid,
                },
              },
              create: {
                studentGuid: student.studentGuid,
                eventId: item.eventid,
                eventText: sanitizedText,
                expirationDate,
                inSite: item.inSite,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                eventText: sanitizedText,
                expirationDate,
                inSite: item.inSite,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert message board item ${item.eventid}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`MessageBoard sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`MessageBoard sync failed for ${student.studentGuid}: ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        failedCount++;
        if (errorMessages.length < 10) errorMessages.push(msg);
      }
    }

    return {
      status: failedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: 0,
        updatedCount: totalUpsertCount,
        failedCount,
      },
      errorMessages,
    };
  }
}
