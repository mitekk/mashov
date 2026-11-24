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
import {
  describeMashovFailure,
  isMashovRejection,
  readReason,
  type MashovReason,
} from '../common/mashov-login/mashov-reason';
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

/**
 * The upstream paths, as literals for the log line. Never read from
 * `err.config?.url` -- see `describeMashovFailure`.
 */
const SEND_PATH = '/api/login/mfa/send';
const VERIFY_PATH = '/api/login/mfa/verify';

/**
 * Reasons that say something about a code the parent typed, and therefore
 * cannot be true at the send stage, where there is no code yet.
 *
 * `MfaExpired` is deliberately NOT here, and that is the difference from the
 * OTP surface: a resend acts on a challenge that already exists, so the
 * challenge really can have expired by the time the parent asks again, and
 * `MFA_CODE_EXPIRED` ("ask for a new one") is the right answer. OTP step 1 has
 * no prior challenge, so there all three are nonsense.
 */
const CODE_VALIDITY_REASONS = new Set<MashovReason>([
  'MfaInvalidCode',
  'MfaCodeExpired',
]);

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
    // whether the connection existed beforehand.
    //
    // This comment used to go on to say "and the stored `uniquId` makes Mashov
    // recognise a known device", which was false — `verifyMfa` has never sent
    // it, and `VerifyMfaInput` has no field for it. The omission turns out to
    // be right, so it is now deliberate rather than accidental:
    //
    // TODO(capture): when `/api/login` answers `403 Reason: MfaRequired`, axios
    // throws, so `readLoginHeaders` never runs and the `Set-Cookie: uniquId` on
    // that 403 is discarded. `mashovUniqueId` below is therefore an OLDER
    // session's cookie. If Mashov binds a challenge to its session cookie,
    // sending a stale one is strictly worse than sending none, so this flow
    // keeps sending none until a wire capture answers two questions: does the
    // triggering 403 carry a `Set-Cookie: uniquId`, and does `mfa/verify`
    // echo back a different one? If yes, the fix is to carry the challenge's
    // OWN cookie — keyed by `challengeId` in Redis — not the stored one.
    // The other three flows (`requestOtp`, `verifyOtp`, credential-setup) do
    // send it; see `MashovRecoveryService.headers()` for why they are safe.
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
      throw this.classify(err, 'verify', semel);
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
  private classify(
    err: unknown,
    stage: 'send' | 'verify',
    // Absent on the resend route, which holds only a `challengeId` -- a bearer
    // handle for someone else's challenge, so not a substitute.
    semel?: number,
  ): HttpException {
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

    const reason = readReason(err);

    // No code exists at the send stage, so nothing Mashov says about one can
    // be true of anything the parent did.
    const codeValidityAtSendStage =
      stage === 'send' && reason !== undefined && CODE_VALIDITY_REASONS.has(reason);

    switch (codeValidityAtSendStage ? undefined : reason) {
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

    this.logger.warn(
      `Mashov MFA ${stage} unmapped: ${describeMashovFailure(err, {
        stage,
        semel,
        path: stage === 'send' ? SEND_PATH : VERIFY_PATH,
      })}`,
    );

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
      // At the send stage no code exists yet, so blaming one is false -- the
      // same defect this flow shipped with on the OTP surface. Its own code
      // rather than INVALID_MFA_CODE, because the parent is sitting on an open
      // challenge and needs to know the resend failed, not that they mistyped.
      //
      // 422 for the same reason as `OTP_REQUEST_REFUSED`: understood, cannot
      // be fulfilled, and nothing was typed to be malformed.
      if (stage === 'send') {
        return envelope(
          'MFA_SEND_REFUSED',
          'Mashov would not send a code for this account.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

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
