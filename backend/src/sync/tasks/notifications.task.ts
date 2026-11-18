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

interface ConnectionRow {
  id: string;
  schoolCode: number;
  schoolYear: number;
  username: string;
  encryptedPassword: string;
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

  /**
   * `/api/user/notifications` is per Mashov account, not per child, and it
   * used to be fetched for ONE connection -- `findFirst` -- so a second school
   * simply never had its notifications read. Now one run per connection, in
   * the shape MailInboxTask already uses.
   *
   * `upstreamNotificationId` is a per-school counter, so two schools collide
   * on it. It is keyed with the connection, and the fingerprint used for
   * ID-less notifications folds the connection in too.
   */
  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });

    const useSharedSession = !context.connectionId && connections.length === 0;
    const connectionList: Array<ConnectionRow | null> = useSharedSession
      ? [null]
      : (connections as ConnectionRow[]);

    let totalFetchedCount = 0;
    let totalCreatedCount = 0;
    let totalUpdatedCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connectionList) {
      // Suffixed per connection, like mail_inbox: one `notifications` row for
      // two schools would make the second overwrite the first's health, and
      // FreshnessService reads these rows per connection.
      const source = conn
        ? `${NotificationsTask.SOURCE}:${conn.id}`
        : NotificationsTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(
        source,
        conn?.id ?? context.connectionId,
      );

      let fetchedCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let failedCount = 0;
      const errorMessages: string[] = [];

      try {
        const refererHeaders = { Referer: 'https://web.mashov.info/students/main/home' };
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
              const createData = {
                upstreamNotificationId: notif.id,
                householdConnectionId: conn?.id ?? null,
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
              };
              const updateData = {
                eventText: notif.eventText,
                readTime,
                // Re-stamped on every pass, so a row the ownership backfill
                // could not attribute heals itself within one cycle.
                ...(conn ? { householdConnectionId: conn.id } : {}),
                parsedEventData: parsedEventData as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: notif as unknown as import('@prisma/client').Prisma.InputJsonValue,
              };

              if (conn) {
                // Keyed on (connection, upstream id): the id alone is a
                // per-school counter, and two schools sharing it meant one
                // school's notification silently replaced the other's.
                await this.prisma.notificationEvent.upsert({
                  where: {
                    householdConnectionId_upstreamNotificationId: {
                      householdConnectionId: conn.id,
                      upstreamNotificationId: notif.id,
                    },
                  },
                  create: createData,
                  update: updateData,
                });
              } else {
                // The shared env session owns no connection, and a NULL cannot
                // be looked up through a unique index -- NULLs are distinct, so
                // Prisma types the compound key's fields as non-nullable.
                // Find-then-write is the same observable behaviour for the one
                // path that has no owner.
                const existing = await this.prisma.notificationEvent.findFirst({
                  where: {
                    householdConnectionId: null,
                    upstreamNotificationId: notif.id,
                  },
                  select: { id: true },
                });
                if (existing) {
                  await this.prisma.notificationEvent.update({
                    where: { id: existing.id },
                    data: updateData,
                  });
                } else {
                  await this.prisma.notificationEvent.create({ data: createData });
                }
              }
              updatedCount++;
            } else {
              // ID-less notification (eventType 16) -- use a fingerprint.
              //
              // The connection goes into the hash input rather than into a new
              // index: `fingerprint @unique` stays exactly as it is, and the
              // two schools' hashes simply differ. Legacy ID-less rows are
              // re-created once under the new hash; nothing reads them.
              const userId = notif.userId;
              const dateKey = eventAt.toISOString().split('T')[0];
              const fingerprint = crypto
                .createHash('sha256')
                .update(`${conn?.id ?? 'shared'}:${userId}:${notif.eventType}:${dateKey}`)
                .digest('hex');

              const existing = await this.prisma.notificationEvent.findUnique({
                where: { fingerprint },
              });

              if (!existing) {
                await this.prisma.notificationEvent.create({
                  data: {
                    fingerprint,
                    householdConnectionId: conn?.id ?? null,
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
                    ...(conn ? { householdConnectionId: conn.id } : {}),
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
        this.logger.debug(
          `Notifications sync (conn=${conn?.id ?? 'shared'}): fetched=${fetchedCount} ` +
            `created=${createdCount} updated=${updatedCount}`,
        );

        totalFetchedCount += fetchedCount;
        totalCreatedCount += createdCount;
        totalUpdatedCount += updatedCount;
        totalFailedCount += failedCount;
        allErrorMessages.push(...errorMessages);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Notifications sync failed (conn=${conn?.id ?? 'shared'}): ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        totalFetchedCount += fetchedCount;
        totalCreatedCount += createdCount;
        totalUpdatedCount += updatedCount;
        totalFailedCount += failedCount + 1;
        allErrorMessages.push(...errorMessages, msg);
      }
    }

    return {
      status: totalFailedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: totalCreatedCount,
        updatedCount: totalUpdatedCount,
        failedCount: totalFailedCount,
      },
      errorMessages: allErrorMessages.slice(0, 10),
    };
  }
}
