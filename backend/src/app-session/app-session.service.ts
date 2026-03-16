import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SESSION_CACHE_TTL = 300; // 5 minutes
const DB_DEBOUNCE_SECONDS = 60;

interface SessionCachePayload {
  userId: string;
  expiresAt: string;
}

@Injectable()
export class AppSessionService {
  private readonly logger = new Logger(AppSessionService.name);
  private readonly lastDbUpdateMap = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async createSession(userId: string, _ipAddress?: string): Promise<string> {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const lifetimeDays = Number(
      this.configService.get<string>('SESSION_LIFETIME_DAYS') ?? '30',
    );
    const expiresAt = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);
    const now = new Date();

    await this.prisma.appSession.create({
      data: {
        userId,
        sessionToken,
        expiresAt,
        lastActivityAt: now,
      },
    });

    const payload: SessionCachePayload = {
      userId,
      expiresAt: expiresAt.toISOString(),
    };
    await this.redis.set(
      `session:${sessionToken}`,
      JSON.stringify(payload),
      SESSION_CACHE_TTL,
    );

    return sessionToken;
  }

  async validateSession(token: string): Promise<string | null> {
    const cacheKey = `session:${token}`;

    // 1. Try Redis cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const payload = JSON.parse(cached) as SessionCachePayload;
        const expiresAt = new Date(payload.expiresAt);
        if (expiresAt > new Date()) {
          // Rolling TTL
          await this.redis.expire(cacheKey, SESSION_CACHE_TTL);
          this.debounceDbActivityUpdate(token);
          return payload.userId;
        }
      } catch {
        // Corrupt cache entry — fall through to DB
      }
      await this.redis.del(cacheKey);
    }

    // 2. DB lookup on cache miss
    const session = await this.prisma.appSession.findUnique({
      where: { sessionToken: token },
    });

    if (!session || session.revokedAt !== null || session.expiresAt <= new Date()) {
      if (session) {
        await this.redis.del(cacheKey);
      }
      return null;
    }

    // Repopulate cache
    const payload: SessionCachePayload = {
      userId: session.userId,
      expiresAt: session.expiresAt.toISOString(),
    };
    await this.redis.set(cacheKey, JSON.stringify(payload), SESSION_CACHE_TTL);
    this.debounceDbActivityUpdate(token);

    return session.userId;
  }

  async revokeSession(token: string): Promise<void> {
    await this.prisma.appSession.updateMany({
      where: { sessionToken: token, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.redis.del(`session:${token}`);
    this.lastDbUpdateMap.delete(token);
  }

  async revokeAllSessionsForUser(userId: string): Promise<void> {
    const sessions = await this.prisma.appSession.findMany({
      where: { userId, revokedAt: null },
      select: { sessionToken: true },
    });

    await this.prisma.appSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    for (const session of sessions) {
      await this.redis.del(`session:${session.sessionToken}`);
      this.lastDbUpdateMap.delete(session.sessionToken);
    }
  }

  @Cron('0 2 * * *')
  async cleanupExpiredSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    try {
      const result = await this.prisma.appSession.deleteMany({
        where: {
          revokedAt: { not: null, lt: cutoff },
        },
      });
      this.logger.log(`Cleaned up ${result.count} expired sessions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Session cleanup failed: ${msg}`);
    }
  }

  private debounceDbActivityUpdate(token: string): void {
    const now = Date.now();
    const last = this.lastDbUpdateMap.get(token) ?? 0;
    if (now - last < DB_DEBOUNCE_SECONDS * 1000) return;

    this.lastDbUpdateMap.set(token, now);
    this.prisma.appSession
      .updateMany({
        where: { sessionToken: token, revokedAt: null },
        data: { lastActivityAt: new Date() },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update session lastActivityAt: ${msg}`);
      });
  }
}
