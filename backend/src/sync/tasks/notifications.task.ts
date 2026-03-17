import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import * as crypto from 'crypto';

interface MashovNotification {
  id?: number;
  userId: string;
  appName?: string;
  eventTime: string;
  eventType: number;
  eventText: string;
  eventKey?: string;
  eventKey2?: string;
  eventData?: string;
  eventUserId?: string;
  addTime?: string;
  readTime?: string;
}

@Injectable()
export class NotificationsTask {
  private readonly logger = new Logger(NotificationsTask.name);
  public static readonly SOURCE = 'notifications';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('*/5 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const conn = context.connectionId
      ? await this.prisma.householdConnection.findFirst({
          where: { id: context.connectionId, userId: { not: null }, active: true },
        })
      : await this.prisma.householdConnection.findFirst({
          where: { userId: { not: null }, active: true },
        });

    const syncRun = await this.syncRunService.openRun(NotificationsTask.SOURCE, conn?.id ?? context.connectionId);
    let fetchedCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    try {
      const refererHeaders = { 'Referer': 'https://web.mashov.info/students/main/home' };
      const notifications = conn
        ? await this.mashovClient.getForConnection<MashovNotification[]>(
            '/api/user/notifications?skip=0&take=50',
            conn.id,
            conn.schoolCode,
            conn.schoolYear,
            conn.username,
            this.encryptionService.decrypt(conn.encryptedPassword),
            { headers: refererHeaders },
          )
        : await this.mashovClient.get<MashovNotification[]>(
            '/api/user/notifications?skip=0&take=50',
            { headers: refererHeaders },
          );

      fetchedCount = notifications.length;

      for (const notif of notifications) {
        try {
          let parsedEventData: Record<string, unknown> | null = null;
          if (notif.eventData) {
            try {
              parsedEventData = JSON.parse(notif.eventData) as Record<string, unknown>;
            } catch {
              // ignore parse errors
            }
          }

          const eventAt = new Date(notif.eventTime);
          const addTime = notif.addTime ? new Date(notif.addTime) : null;
          const readTime = notif.readTime ? new Date(notif.readTime) : null;

          if (notif.id) {
            // Has a stable ID
            const result = await this.prisma.notificationEvent.upsert({
              where: { upstreamNotificationId: notif.id },
              create: {
                upstreamNotificationId: notif.id,
                eventType: notif.eventType,
                eventText: notif.eventText,
                eventKey: notif.eventKey ?? null,
                eventKey2: notif.eventKey2 ?? null,
                studentGuid: notif.eventUserId ?? null,
                eventAt,
                addTime,
                readTime,
                parsedEventData: parsedEventData as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: notif as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                eventText: notif.eventText,
                readTime,
                parsedEventData: parsedEventData as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: notif as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            if (result) updatedCount++;
          } else {
            // ID-less notification (eventType 16) — use fingerprint
            const userId = notif.userId;
            const dateKey = eventAt.toISOString().split('T')[0];
            const fingerprint = crypto
              .createHash('sha256')
              .update(`${userId}:${notif.eventType}:${dateKey}`)
              .digest('hex');

            const existing = await this.prisma.notificationEvent.findUnique({
              where: { fingerprint },
            });

            if (!existing) {
              await this.prisma.notificationEvent.create({
                data: {
                  fingerprint,
                  eventType: notif.eventType,
                  eventText: notif.eventText,
                  studentGuid: null,
                  eventAt,
                  addTime,
                  readTime,
                  parsedEventData: parsedEventData as import('@prisma/client').Prisma.InputJsonValue,
                  rawPayload: notif as unknown as import('@prisma/client').Prisma.InputJsonValue,
                },
              });
              createdCount++;
            } else {
              await this.prisma.notificationEvent.update({
                where: { fingerprint },
                data: {
                  eventText: notif.eventText,
                  readTime,
                  rawPayload: notif as unknown as import('@prisma/client').Prisma.InputJsonValue,
                },
              });
              updatedCount++;
            }
          }
        } catch (itemErr) {
          const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
          this.logger.warn(`Failed to upsert notification: ${msg}`);
          failedCount++;
          if (errorMessages.length < 10) errorMessages.push(msg);
        }
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', {
        fetchedCount,
        createdCount,
        updatedCount,
      });
      this.logger.debug(`Notifications sync: fetched=${fetchedCount} created=${createdCount} updated=${updatedCount}`);
      return {
        status: failedCount > 0 ? 'failed' : 'success',
        summary: {
          fetchedCount,
          createdCount,
          updatedCount,
          failedCount,
        },
        errorMessages,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Notifications sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      return {
        status: 'failed',
        summary: {
          fetchedCount,
          createdCount,
          updatedCount,
          failedCount: failedCount + 1,
        },
        errorMessages: [...errorMessages, msg],
      };
    }
  }
}
