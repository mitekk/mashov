import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { isUpstreamUnreachable } from '../common/http/mashov-http';
import { buildLoginBody } from '../common/mashov-login/mashov-login-body';
import {
  MashovRecoveryService,
  type MfaMethod,
} from '../common/mashov-login/mashov-recovery.service';
import { isMashovRejection, readReason } from '../common/mashov-login/mashov-reason';
import { countAgainstLimit } from '../common/mashov-login/rate-limit';
import { RedisService } from '../redis/redis.service';
import { AuthService } from './auth.service';

/**
 * Answering a Mashov MFA challenge, inside our app.
 *
 * `POST /api/login` answers `403 Reason: MfaRequired` with a `challengeId`.
 * Until now that rendered as "wrong password" and the parent had nowhere to go
 * but Mashov's own site. These two calls finish the sign-in here.
 *
 * Its own provider rather than more methods on `AuthService`, whose `login()`
 * is already the highest-risk method in the backend -- but it mints the session
 * through `AuthService.persistSessionFromLogin`, so an MFA sign-in gets exactly
 * the same adoption rules, the same roster write and the same
 * `credentialStaleAt` clearing as a password sign-in. A second copy of that is
 * how an MFA sign-in would quietly skip adoption and drop a parent into an
 * empty app.
 *
 * Nothing here may answer 401: `apiFetch` hard-redirects the browser on any 401
 * whose code is not `INVALID_CREDENTIALS`, which would throw the parent off the
 * code-entry screen and lose a one-time code they have to wait to replace.
 */
const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 900;
/**
 * Per challenge, so a botnet cannot grind one six-digit code from many
 * addresses. Deliberately above the number of attempts a real parent needs and
 * far below the 10^6 a brute force does.
 */
const CHALLENGE_LIMIT = 10;
const CHALLENGE_WINDOW_SECONDS = 900;

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly schoolYearService: SchoolYearService,
    private readonly upstream: MashovRecoveryService,
    private readonly redis: RedisService,
  ) {}

  /** Ask Mashov to (re)send the code for an open challenge. */
  async sendCode(
    challengeId: string,
    method: MfaMethod,
    ip: string,
  ): Promise<{ ok: true }> {
    // Unmetered, this route lets anyone holding a challenge id text a victim's
    // phone as often as they like. Mashov's own `MfaResendTooSoon` is a brake,
    // but relying on it puts our abuse budget in their hands.
    await countAgainstLimit(this.redis, `ratelimit:mfa:${ip}`, IP_LIMIT, IP_WINDOW_SECONDS);
    await countAgainstLimit(
      this.redis,
      `ratelimit:mfa:challenge:${challengeId}`,
      CHALLENGE_LIMIT,
      CHALLENGE_WINDOW_SECONDS,
    );

    try {
      await this.upstream.sendMfa(challengeId, method);
      return { ok: true };
    } catch (err) {
      throw this.classify(err, 'send');
    }
  }

  /**
   * Answer the challenge and sign in.
   *
   * Takes the password even though `POST /api/login/mfa/verify` rejects it: the
   * upstream call strips it, and OUR side needs it. Sixteen cron tasks re-login
   * by decrypting the stored credential, so without a password the household
   * gets a working session and no background sync at all. Mashov has already
   * validated it -- answering `MfaRequired` rather than `401` IS that
   * validation -- so the caller holding it has had it checked.
   */
  async createSession(
    challengeId: string,
    input: {
      semel: number;
      username: string;
      password: string;
      code: string;
      rememberBrowser?: boolean;
    },
    ip: string,
  ): Promise<{ sessionToken: string; isFirstLogin: boolean }> {
    const semel = Number(input.semel);

    // Per IP and per challenge: per-IP alone does nothing against a botnet
    // grinding one six-digit code, which is the whole attack this route
    // invites.
    await countAgainstLimit(this.redis, `ratelimit:mfa:${ip}`, IP_LIMIT, IP_WINDOW_SECONDS);
    await countAgainstLimit(
      this.redis,
      `ratelimit:mfa:challenge:${challengeId}`,
      CHALLENGE_LIMIT,
      CHALLENGE_WINDOW_SECONDS,
    );

    // Read BEFORE the login, like `AuthService.login` does: adoption turns on
    // whether the connection existed beforehand, and the stored `uniquId` makes
    // Mashov recognise a known device.
    const existingConnBeforeLogin = await this.prisma.householdConnection.findUnique({
      where: { schoolCode_username: { schoolCode: semel, username: input.username } },
      select: { id: true, mashovUniqueId: true, userId: true },
    });

    const resolved = await this.schoolYearService.resolveForSchool(semel);

    let result;
    try {
      result = await this.upstream.verifyMfa({
        // The shared builder, with no password: this route rejects one, and
        // `MashovRecoveryService.verifyMfa` strips it anyway.
        loginData: buildLoginBody({
          semel,
          year: resolved.year,
          username: input.username,
        }),
        challengeId,
        code: input.code,
        // Forced on, not taken from the client. The trusted-device credential
        // is not a user preference: it is the only thing that keeps background
        // sync alive for an MFA account, because every cron re-login would
        // otherwise re-open this same challenge.
        rememberBrowser: true,
      });
    } catch (err) {
      throw this.classify(err, 'verify');
    }

    if (!result.data?.credential?.userId) {
      // A 200 with no credential is not a session. Minting one would hand out
      // a cookie for a household we cannot identify.
      this.logger.error(
        `MFA verify for semel=${semel} returned no credential.userId; refusing to mint a session`,
      );
      throw new HttpException(
        {
          error: {
            code: 'INVALID_MFA_CODE',
            message: 'Mashov did not complete the sign-in. Please try again.',
            details: [],
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // The token, not a cookie: the controller owns the cookie options so an
    // MFA sign-in and a password sign-in set byte-identical cookies.
    return this.authService.persistSessionFromLogin({
      semel,
      username: input.username,
      password: input.password,
      year: resolved.year,
      loginData: result.data,
      newUniqueId: result.newUniqueId,
      devicePass: result.devicePass,
      // NOT proven: `mfa/verify` strips the password, so neither Mashov nor we
      // checked it. The screen re-asks for it, which makes a typo likely, and
      // a typo must not clear a school's stale-credential flag.
      credentialProven: false,
      ip,
      existingConnBeforeLogin,
    });
  }

  /**
   * Upstream failure → our envelope.
   *
   * Every branch is 400, 422, 429 or 502. Never 401, and never a code that
   * blames the parent for an outage: a one-time code they cannot immediately
   * replace is at stake.
   */
  private classify(err: unknown, stage: 'send' | 'verify'): HttpException {
    if (isUpstreamUnreachable(err)) {
      this.logger.error(
        `Mashov MFA ${stage} unreachable: ${
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
      case 'MfaInvalidCode':
        return envelope(
          'INVALID_MFA_CODE',
          'That code is not valid.',
          HttpStatus.BAD_REQUEST,
        );
      case 'MfaCodeExpired':
      case 'MfaExpired':
        return envelope(
          'MFA_CODE_EXPIRED',
          'That code has expired. Please ask for a new one.',
          HttpStatus.BAD_REQUEST,
        );
      case 'MfaLocked':
        return envelope(
          'MFA_LOCKED',
          'Too many attempts. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'MfaResendTooSoon':
        return envelope(
          'MFA_RESEND_TOO_SOON',
          'A code was just sent. Please wait before asking for another.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'MfaContactMissing':
        return envelope(
          'MFA_CONTACT_MISSING',
          'Mashov has no email address or phone number on file for this account.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      case 'UserSuspended':
        return envelope(
          'CAPTCHA_REQUIRED',
          'Mashov is asking for a captcha before this account can sign in.',
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
      // Only Mashov's API gets to say a code is wrong. A proxy ACL 403 told as
      // "wrong code" costs the parent a one-time code they must wait to
      // replace.
      isMashovRejection(err)
    ) {
      // Includes an upstream 401. Rendered as 400 deliberately -- see the class
      // docblock on why nothing here may answer 401.
      return envelope(
        'INVALID_MFA_CODE',
        'That code is not valid.',
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

function envelope(code: string, message: string, status: HttpStatus): HttpException {
  return new HttpException({ error: { code, message, details: [] } }, status);
}
