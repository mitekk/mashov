import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { createMashovAxios, resolveMashovBaseUrl } from '../http/mashov-http';
import { currentSchoolYearFor } from './school-year.scope';

/** How the resolved year was arrived at — logged, and surfaced in source health. */
export type SchoolYearSource = 'override' | 'schools-api' | 'calendar' | 'stored';

export interface ResolvedSchoolYear {
  year: number;
  source: SchoolYearSource;
}

/** Shape of the pieces of `POST /api/login` this service reads. */
export interface SchoolYearLoginView {
  credential?: { year?: number | null } | null;
  accessToken?: {
    schoolSettings?: { schoolYear?: number | null } | null;
    userSchoolYears?: number[] | null;
  } | null;
}

interface SchoolsApiEntry {
  semel?: number;
  years?: number[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Mashov names a school year by its *ending* calendar year: `2026` means
 * Sep 2025 – Jun 2026. So from September onwards the live year is next
 * January's year.
 */
export function calendarSchoolYear(now: Date): number {
  const year = now.getFullYear();
  return now.getMonth() >= 8 ? year + 1 : year;
}

/**
 * Resolves which Mashov school year the app should be asking for.
 *
 * The year used to be a deploy-time constant (`MASHOV_YEAR=2026`), which froze
 * every sync on a year that had ended: Mashov scopes the whole session to the
 * year in the login body, so a stale year means stale data on every downstream
 * GET while the crons keep reporting success.
 *
 * Deliberately does NOT depend on `MashovSessionModule`: `AuthModule`,
 * `ConnectionModule` and `SyncModule` all consume this service, and routing the
 * `/api/schools` call through the session module would make a cycle.
 */
@Injectable()
export class SchoolYearService {
  private readonly logger = new Logger(SchoolYearService.name);
  private readonly http: AxiosInstance;
  private readonly cache = new Map<number, { resolved: ResolvedSchoolYear; at: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.http = createMashovAxios(
      resolveMashovBaseUrl(this.configService.get<string>('MASHOV_BASE_URL')),
    );
  }

  /**
   * Phase 1 — the year to put in the login body, before Mashov has had a chance
   * to say which year is actually active. `reconcileFromLogin` is phase 2.
   */
  async resolveForSchool(semel: number): Promise<ResolvedSchoolYear> {
    const override = this.readOverride();
    if (override !== null) {
      return { year: override, source: 'override' };
    }

    const cached = this.cache.get(semel);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.resolved;
    }

    const calendarYear = calendarSchoolYear(new Date());
    const apiYear = await this.maxYearFromSchoolsApi(semel);

    // max(), not the API alone: the published `years[]` appears to lag the
    // in-progress year, and the calendar never lags. An over-shoot is caught
    // by reconcileFromLogin.
    let year = Math.max(calendarYear, apiYear ?? 0);
    let source: SchoolYearSource =
      apiYear !== null && apiYear >= calendarYear ? 'schools-api' : 'calendar';

    // Nothing legitimate is ever more than one year ahead of the calendar.
    const ceiling = calendarYear + 1;
    if (year > ceiling) {
      year = ceiling;
      source = 'calendar';
    }

    // Never regress: a connection already talking to a later year keeps it.
    const storedYear = await this.storedYearForSchool(semel);
    if (storedYear !== null && storedYear > year) {
      year = storedYear;
      source = 'stored';
    }

    const resolved: ResolvedSchoolYear = { year, source };
    this.cache.set(semel, { resolved, at: Date.now() });
    this.logger.log(`resolved year=${year} source=${source} semel=${semel}`);
    return resolved;
  }

  /**
   * Phase 2 — Mashov is the authority on which year is active. Returns
   * `changed: true` when the caller must re-login with the corrected year,
   * because the session cookies it already holds are scoped to the wrong one.
   */
  reconcileFromLogin(
    candidate: number,
    login: SchoolYearLoginView,
  ): { year: number; changed: boolean } {
    const schoolYear = login.accessToken?.schoolSettings?.schoolYear ?? null;
    const credentialYear = login.credential?.year ?? null;
    let authoritative = schoolYear ?? credentialYear ?? candidate;

    const enrolled = login.accessToken?.userSchoolYears;
    if (Array.isArray(enrolled) && enrolled.length > 0 && !enrolled.includes(authoritative)) {
      const ceiling = schoolYear ?? authoritative;
      const best = enrolled.filter((entry) => entry <= ceiling).sort((a, b) => b - a)[0];
      if (best !== undefined) {
        authoritative = best;
      }
    }

    return { year: authoritative, changed: authoritative !== candidate };
  }

  /** The year to scope a user's reads to — their connection's, else the calendar. */
  async currentSchoolYearFor(userId?: string): Promise<number> {
    return currentSchoolYearFor(this.prisma, userId);
  }

  /** Drops the cached resolution for a semel — used right after a rollover. */
  invalidate(semel?: number): void {
    if (semel === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(semel);
    }
  }

  private readOverride(): number | null {
    const raw = this.configService.get<string | number>('MASHOV_YEAR');
    if (raw === undefined || raw === null) return null;
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private async maxYearFromSchoolsApi(semel: number): Promise<number | null> {
    try {
      const response = await this.http.get<SchoolsApiEntry[]>('/api/schools');
      const entry = (response.data ?? []).find((school) => Number(school?.semel) === Number(semel));
      const years = (entry?.years ?? []).filter((year) => Number.isInteger(year));
      return years.length > 0 ? Math.max(...years) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`/api/schools unavailable for semel=${semel}: ${message}`);
      return null;
    }
  }

  private async storedYearForSchool(semel: number): Promise<number | null> {
    const connection = await this.prisma.householdConnection.findFirst({
      where: { schoolCode: Number(semel) },
      orderBy: { schoolYear: 'desc' },
      select: { schoolYear: true },
    });
    return connection?.schoolYear ?? null;
  }
}
