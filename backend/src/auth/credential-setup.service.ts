import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { isUpstreamUnreachable } from '../common/http/mashov-http';
import { buildLoginBody } from '../common/mashov-login/mashov-login-body';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';
import { assertPasswordPolicy } from '../common/mashov-login/password-policy';
import { isMashovRejection, readChallengeId, readReason } from '../common/mashov-login/mashov-reason';
import { countAgainstLimit, identityKeyHash } from '../common/mashov-login/rate-limit';
import { RedisService } from '../redis/redis.service';
import { EncryptionService } from '../session/encryption.service';
import { AuthService } from './auth.service';
import { isTakenUsernameConflict } from '../common/prisma-conflicts';
import type { MashovLoginPayload } from '../common/mashov-login/mashov-credential-validator.service';

/**
 * The forced credential change: `403 Reason: ChangePass`,
 * `SetUsernameAndPass` or `CreateUsername`.
 *
 * In all three the parent's password is CORRECT and Mashov still will not let
 * them in until they replace it (or pick a username). Collapsed into "wrong
 * password", that was a loop of retyping a right password until the rate
 * limiter locked them out, with no path but Mashov's own site.
 *
 * On success it mints a session through `AuthService.persistSessionFromLogin`,
 * storing the NEW password -- otherwise every background sync from the next
 * cron onwards would be using a credential Mashov has just replaced.
 */
/** 5 per quarter hour per IP, matching the login limiter's shape. */
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 900;
/** Tighter per identity: nobody legitimately changes one account's password 5x an hour. */
const IDENTITY_LIMIT = 5;
const IDENTITY_WINDOW_SECONDS = 3600;

@Injectable()
export class CredentialSetupService {
  private readonly logger = new Logger(CredentialSetupService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly schoolYearService: SchoolYearService,
    private readonly upstream: MashovRecoveryService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
  ) {}

  async setCredentials(
    input: {
      semel: number;
      username: string;
      /** The current password. This route proves it before changing anything. */
      password: string;
      newPassword?: string;
      newUsername?: string;
      /** From the 403 that demanded the change. */
      challengeId?: string;
    },
    ip: string,
  ): Promise<{ sessionToken: string; isFirstLogin: boolean }> {
    const semel = Number(input.semel);

    // Rate limited FIRST, and this route needs it more than any other in the
    // surface. It is unauthenticated, it takes a current password, it answers
    // `400 INVALID_CREDENTIALS` for a wrong one and a session cookie for a
    // right one -- an unmetered password oracle that routes straight around
    // `ratelimit:login`. It also changes a third party's password on every
    // success, which makes it the obvious lever for anyone wanting to use us
    // as an abuse amplifier against Mashov.
    await countAgainstLimit(
      this.redis,
      `ratelimit:credentials:${ip}`,
      IP_LIMIT,
      IP_WINDOW_SECONDS,
    );
    await countAgainstLimit(
      this.redis,
      // Hashed: a Mashov username is usually a national ID number, and a raw
      // key would park one under a greppable Redis key.
      `ratelimit:credentials:id:${semel}:${identityKeyHash(
        this.encryption.hashKey(),
        input.username,
      )}`,
      IDENTITY_LIMIT,
      IDENTITY_WINDOW_SECONDS,
    );

    const newUsername = input.newUsername?.trim() || undefined;
    const newPassword = input.newPassword || undefined;

    if (!newPassword && !newUsername) {
      throw envelope(
        'VALIDATION_ERROR',
        'Either newPassword or newUsername is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Before any upstream call, and against the FINAL username: Mashov's own
    // change-password dialog refuses a password containing the username, and
    // if the username is changing in the same request it is the new one that
    // matters.
    const effectiveUsername = newUsername ?? input.username;
    if (newPassword) {
      assertPasswordPolicy(newPassword, effectiveUsername);
    }

    const existingConnBeforeLogin = await this.prisma.householdConnection.findUnique({
      where: { schoolCode_username: { schoolCode: semel, username: input.username } },
      select: { id: true, mashovUniqueId: true, userId: true },
    });

    const resolved = await this.schoolYearService.resolveForSchool(semel);

    let payload: MashovLoginPayload | undefined;
    let devicePass: string | undefined;
    let newUniqueId: string | undefined;
    let username = input.username;

    try {
      if (newUsername) {
        const result = await this.upstream.changeUsername({
          loginData: buildLoginBody({
            semel,
            year: resolved.year,
            username,
            password: input.password,
          }),
          username: newUsername,
          challengeId: input.challengeId,
        });
        // From here on everything is posted against the new name: asking
        // Mashov to change the password of an account that no longer has the
        // old name is a different request.
        username = newUsername;
        payload = result.data;
        devicePass = result.devicePass;
        newUniqueId = result.newUniqueId;
      }

      if (newPassword) {
        const result = await this.upstream.changePassword({
          loginData: buildLoginBody({
            semel,
            year: resolved.year,
            username,
            password: input.password,
          }),
          newPassword,
          challengeId: input.challengeId,
        });
        payload = result.data;
        devicePass = result.devicePass;
        newUniqueId = result.newUniqueId;
      }
    } catch (err) {
      throw this.classify(err, semel);
    }

    if (!payload?.credential?.userId) {
      this.logger.error(
        `Credential change for semel=${semel} returned no credential.userId; refusing to mint a session`,
      );
      throw envelope(
        'CREDENTIALS_SETUP_FAILED',
        'Mashov did not confirm the change. Please try again.',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.persistSession({
      semel,
      username,
      // The credential that now works. Storing the old one would break every
      // background sync from the next cron onwards.
      password: newPassword ?? input.password,
      year: resolved.year,
      loginData: payload,
      newUniqueId,
      devicePass,
        // Mashov accepted the current password on the way to changing it, so
        // this credential is proven and the stale flag can be cleared.
        credentialProven: true,
        ip,
        existingConnBeforeLogin,
      });
    } catch (err) {
      // Mashov took the rename; OUR unique key refused it. That is the other
      // parent's account at this school, or an orphan row from an earlier
      // unlink -- foreseeable on the one path that deliberately changes a
      // username, and a raw P2002 would reach the exception filter as a 500
      // that tells the parent nothing.
      if (isTakenUsernameConflict(err)) {
        this.logger.warn(
          `Mashov accepted a username change for semel=${semel} that collides with an existing connection`,
        );
        throw envelope(
          'USERNAME_TAKEN',
          'That username is already in use for this school.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  /** Split out only so the try/catch above reads as one statement. */
  private persistSession(
    input: Parameters<AuthService['persistSessionFromLogin']>[0],
  ): Promise<{ sessionToken: string; isFirstLogin: boolean }> {
    return this.authService.persistSessionFromLogin(input);
  }

  /** Upstream failure → our envelope. Never 401 except a genuine rejection. */
  private classify(err: unknown, semel: number): HttpException {
    if (isUpstreamUnreachable(err)) {
      this.logger.error(
        `Mashov credential change unreachable for semel=${semel}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return envelope(
        'UPSTREAM_ERROR',
        'Mashov is not reachable right now. Please try again shortly.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    switch (readReason(err)) {
      case 'UsernameExists':
        return envelope(
          'USERNAME_TAKEN',
          'That username is already taken in Mashov.',
          HttpStatus.CONFLICT,
        );
      case 'UsernameLocked':
        return envelope(
          'USERNAME_LOCKED',
          'Too many username changes. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'MfaRequired':
        // The challenge id rides along, or the parent lands on a screen that
        // knows a code is needed and has no handle to ask for one -- the same
        // dead end this whole surface exists to remove.
        return envelope(
          'MFA_REQUIRED',
          'Mashov requires a one-time code before this change.',
          HttpStatus.BAD_REQUEST,
          readChallengeId(err),
        );
      case 'UserSuspended':
        return envelope(
          'CAPTCHA_REQUIRED',
          'Mashov is asking for a captcha before this change can be made.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      default:
        break;
    }

    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      // Only if Mashov's API answered. A proxy ACL 403 reported as a bad
      // password sends the parent to retype one that was correct.
      isMashovRejection(err)
    ) {
      // Includes the upstream 401: the CURRENT password was rejected. Reported
      // as 400 INVALID_CREDENTIALS rather than a 401, because a 401 would send
      // `apiFetch` into its hard redirect and lose the half-filled form -- and
      // reported as bad credentials rather than as a weak new password, which
      // would send the parent to fix the wrong field.
      return envelope(
        'INVALID_CREDENTIALS',
        'Your current Mashov password was not accepted.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return envelope(
      'UPSTREAM_ERROR',
      'Mashov is not reachable right now. Please try again shortly.',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

function envelope(
  code: string,
  message: string,
  status: HttpStatus,
  challengeId?: string,
): HttpException {
  return new HttpException(
    {
      error: {
        code,
        message,
        details: [],
        ...(challengeId ? { challengeId } : {}),
      },
    },
    status,
  );
}
