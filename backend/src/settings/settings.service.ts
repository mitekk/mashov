import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  async getSourceHealth() {
    const studentGuids = (
      await this.prisma.student.findMany({
        where: { isActive: true },
        select: { studentGuid: true },
      })
    ).map((student) => student.studentGuid);

    const [sources, freshness] = await Promise.all([
      this.freshnessService.getAllSourceHealth(studentGuids),
      this.freshnessService.computeFreshness(),
    ]);

    return {
      sources,
      overallState: freshness.state,
      lastFullSyncAt: freshness.lastSyncAt,
    };
  }

  async getProfile() {
    const [profile, household] = await Promise.all([
      this.prisma.parentProfile.findFirst(),
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      }),
    ]);

    if (!profile) return null;

    return {
      upstreamUserId: profile.upstreamUserId,
      displayName: profile.displayName ?? '',
      email: profile.email ?? '',
      cellphone: profile.cellphone ?? '',
      schoolName: household?.schoolName ?? '',
      schoolYear: household?.schoolYear ?? new Date().getFullYear(),
      schoolCode: household?.schoolCode ?? 0,
      detailsState: profile.detailsState,
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}
