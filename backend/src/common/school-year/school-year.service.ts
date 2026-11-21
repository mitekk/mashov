import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { createMashovAxios, resolveMashovBaseUrl } from '../http/mashov-http';
import { currentSchoolYearFor } from './school-year.scope';

/** How the resolved year was arrived at — logged, and surfaced in source health. */
export type SchoolYearSource = 'schools-api' | 'calendar' | 'stored';

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
  /**
   * The school's display name, per `apis/get-api-schools.md`.
   *
   * Read here because some schools' login response omits
   * `schoolSettings.schoolName` entirely (T13 finding 1), and this list is the
   * only other place the name exists — the sign-in form already loads it to
   * populate the school picker.
   */
  name?: string | null;
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
 * GET while the crons keep reporting success. `MASHOV_YEAR` now means the
 * earliest year to *fetch* (see `schoolYearWindowFor`) and is deliberately not
 * read here: nothing in the environment may decide which year is current.
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
  /**
   * The school's display name per semel, cached separately from the year.
   *
   * Separate because the two are reached independently: `resolveForSchool`
   * warms both, but `schoolNameFor` is also called on semels it has never
   * touched, and a failed `/api/schools` call must leave the name *unknown*
   * rather than cached as "there isn't one" — a single upstream blip would
   * otherwise disable finding 1's fallback for the whole TTL and leave the
   * chip showing a bare semel, which is the symptom being fixed.
   */
  private readonly nameCache = new Map<number, { name: string | null; at: number }>();

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
    const cached = this.cache.get(semel);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.resolved;
    }

    const calendarYear = calendarSchoolYear(new Date());
    // One lookup serves both halves of the entry: the year resolved below and
    // the display name cached on the way past, rather than fetching the list
    // twice. The result is RETURNED rather than stashed on the instance — a
    // household's connections are resolved inside one `Promise.all`
    // (`FreshnessService.computeContentFreshness`), so two semels resolve
    // concurrently in a single request and a shared field gets the name of
    // whichever response lands second.
    const entry = await this.schoolsApiEntry(semel);
    const apiYear = entry.maxYear;

    // max(), not the API alone: the published `years[]` appears to lag the
    // in-progress year, and the calendar never lags. An over-shoot is caught
    // by reconcileFromLogin.
    let year = Math.max(calendarYear, apiYear ?? 0);
    let source: SchoolYearSource =
      apiYear !== null && apiYear >= calendarYear ? 'schools-api' : 'calendar';

    // Never regress: a connection already talking to a later year keeps it.
    const storedYear = await this.storedYearForSchool(semel);
    if (storedYear !== null && storedYear > year) {
      year = storedYear;
      source = 'stored';
    }

    // The ceiling is applied LAST so that it also bounds the stored year.
    // Applying it before the stored clamp left a fat-fingered hotfix
    // (`UPDATE household_connection SET "schoolYear" = 2072`) pinning every
    // connection at that school to a year with no data, irreversibly: the
    // rollover task never walks a stored year down.
    const ceiling = calendarYear + 1;
    if (year > ceiling) {
      if (source === 'stored') {
        this.logger.error(
          `Stored schoolYear=${year} for semel=${semel} is beyond the plausible ceiling ${ceiling}; ignoring it. Check household_connection."schoolYear".`,
        );
      }
      year = ceiling;
      source = 'calendar';
    }

    const resolved: ResolvedSchoolYear = { year, source };
    this.cache.set(semel, { resolved, at: Date.now() });
    if (entry.reached) this.nameCache.set(semel, { name: entry.name, at: Date.now() });
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
      this.nameCache.clear();
    } else {
      this.cache.delete(semel);
      this.nameCache.delete(semel);
    }
  }

  /**
   * The school's display name from the public `/api/schools` list, or null.
   *
   * T13 finding 1: some schools' `POST /api/login` omits
   * `schoolSettings.schoolName`, so every writer stored null and the
   * `?? String(schoolCode)` fallbacks downstream made the school chip and the
   * contact card read a bare semel. The name was available the whole time — the
   * sign-in form loads this very list to populate its picker.
   *
   * It lives here because `resolveForSchool` already fetches `/api/schools` on
   * every login and caches per semel for six hours, and the name sits on the
   * same entry as `years`. So the fallback costs no new upstream call on the
   * common path: a cache hit answers it, and only a cold semel fetches.
   */
  async schoolNameFor(semel: number): Promise<string | null> {
    const cached = this.nameCache.get(semel);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.name;
    }

    const entry = await this.schoolsApiEntry(semel);
    // Cached only when the list actually answered. A semel genuinely absent
    // from it caches `null` and is served from cache; an unreachable list
    // caches nothing, so the next caller retries instead of inheriting a
    // six-hour "no name" from one blip.
    if (entry.reached) this.nameCache.set(semel, { name: entry.name, at: Date.now() });
    return entry.name;
  }

  /**
   * One `/api/schools` lookup, returning both halves of the matched entry.
   *
   * `reached` distinguishes "the list says this school has no name" from "the
   * list did not answer" — the two must cache differently.
   */
  private async schoolsApiEntry(
    semel: number,
  ): Promise<{ reached: boolean; name: string | null; maxYear: number | null }> {
    try {
      const response = await this.http.get<SchoolsApiEntry[]>('/api/schools');
      const entry = (response.data ?? []).find((school) => Number(school?.semel) === Number(semel));
      // Trimmed and emptiness-checked: a blank name is worse than the semel,
      // because `?? String(schoolCode)` does not fire on an empty string and
      // the chip would render nothing at all.
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const years = (entry?.years ?? []).filter((year) => Number.isInteger(year));
      return {
        reached: true,
        name: name.length > 0 ? name : null,
        maxYear: years.length > 0 ? Math.max(...years) : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`/api/schools unavailable for semel=${semel}: ${message}`);
      return { reached: false, name: null, maxYear: null };
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
