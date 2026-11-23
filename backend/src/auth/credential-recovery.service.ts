import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { isUpstreamUnreachable } from '../common/http/mashov-http';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';
import { assertPasswordPolicy } from '../common/mashov-login/password-policy';
import { readReason, type MashovReason } from '../common/mashov-login/mashov-reason';
import { MashovSessionService } from '../session/mashov-session.service';

/**
 * In-app Mashov password recovery.
 *
 * A separate provider rather than more methods on `AuthService`, whose
 * `login()` is already the highest-risk method in the backend.
 *
 * ## It never mints a session, and never writes `encryptedPassword`
 *
 * This flow is unauthenticated and keyed by `idNumber`, so whoever completes it
 * has proved control of the school-registered email or phone -- NOT ownership
 * of our `AppUser` household, which in a merged household (ADR-0029/0032) is
 * provably not the same person. Minting a session here would hand one of a
 * merged household's parents the other's app.
 *
 * Auto sign-in after a reset is therefore a CLIENT concern: the reset form
 * holds the new password in memory and chains into the existing
 * `POST /api/v1/auth/login`, which re-encrypts the credential, refreshes the
 * roster and heals the connection. Same user experience, boundary intact.
 *
 * ## No enumeration
 *
 * Every identity-shaped upstream failure returns an **indistinguishable 202**
 * carrying a fabricated `recoveryId` marked `poisoned`. Step 2 against a
 * poisoned id answers `INVALID_RECOVERY_CODE` after identical attempt counting
 * and identical password validation, so the two paths differ only in timing.
 *
 * `UserSuspended` is folded into that set on purpose: Mashov only escalates to
 * a captcha for accounts it RECOGNISES, so surfacing `CAPTCHA_REQUIRED` at step
 * 1 would be a perfect "does this ID exist" oracle.
 *
 * Two leaks are accepted and documented in ADR-0042: response **timing** (a
 * real recovery sends an email), and `RECOVERY_THROTTLED`, because hiding a
 * channel lockout leaves a locked-out parent retrying forever.
 *
 * ## Secrecy
 *
 * Codes and passwords are never persisted -- not in Redis, not in a log line,
 * not in an error body. The logger here is deliberately limited to counts and
 * codes-of-our-own; nothing it emits interpolates a secret or a raw ID number.
 */

const RECOVERY_TTL_SECONDS = 900;

const IP_LIMIT = 3;
const IP_WINDOW_SECONDS = 900;
/**
 * Per-identity as well as per-IP. Per-IP alone does nothing against a botnet
 * enumerating one victim, which is the attack this endpoint invites.
 */
const ID_LIMIT = 3;
const ID_WINDOW_SECONDS = 3600;

/** Then the state is deleted, so a brute force cannot resume it. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Upstream answers that mean "slow down", surfaced rather than hidden.
 *
 * The enumeration leak is real but small, and the alternative is worse: a
 * parent whose email channel is locked out would retry forever against a
 * cheerful 202.
 */
const THROTTLE_REASONS = new Set<MashovReason>([
  'EmailLimitExceeded',
  'EmailLocked',
  'CellphoneLocked',
  'MfaResendTooSoon',
]);

export type RecoveryChannel = 'email' | 'sms';

export interface StartRecoveryInput {
  semel: number;
  idNumber: string;
  channel: RecoveryChannel;
}

export interface StartRecoveryResult {
  recoveryId: string;
  requiresSecondChannel: boolean;
  channel: RecoveryChannel;
}

export interface CompletePasswordInput {
  code: string;
  secondCode?: string;
  newPassword: string;
}

export interface CompletePasswordResult {
  ok: true;
  /** Mashov's username for the account. A parent who forgot the password often forgot this too. */
  username: string | undefined;
}

/**
 * What survives between the two steps.
 *
 * The opaque `recoveryId` is what lets step 2 carry no PII at all, and what
 * keeps `isResettingAndVerifying` server-side -- a client that could choose the
 * single-code route for a two-channel account would be choosing its own
 * authorisation strength.
 */
interface RecoveryState {
  semel: number;
  idNumber: string;
  channel: RecoveryChannel;
  isResettingAndVerifying: boolean;
  attempts: number;
  poisoned: boolean;
}

@Injectable()
export class CredentialRecoveryService {
  private readonly logger = new Logger(CredentialRecoveryService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly upstream: MashovRecoveryService,
    private readonly prisma: PrismaService,
    private readonly sessionService: MashovSessionService,
  ) {}

  /**
   * Step 1: ask Mashov to send a code, and hand back an opaque handle.
   *
   * Answers `202` for a real account and for an unknown one alike. Only our own
   * rate limits, an upstream throttle, and an unreachable upstream produce an
   * error.
   */
  async start(input: StartRecoveryInput, ip: string): Promise<StartRecoveryResult> {
    await this.checkIpRateLimit(ip);
    await this.checkIdentityRateLimit(input.semel, input.idNumber);

    let isResettingAndVerifying = false;
    let poisoned = false;

    try {
      const result = await this.upstream.requestRecovery({
        semel: input.semel,
        idNumber: input.idNumber,
        ...(input.channel === 'sms' ? { cellphone: true } : { email: true }),
      });
      isResettingAndVerifying = result.isResettingAndVerifying === true;
    } catch (err) {
      if (isUpstreamUnreachable(err)) {
        this.logger.error(
          `Mashov recovery unreachable for semel=${input.semel}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        throw upstreamError();
      }

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const reason = readReason(err);

      if (status === 429 || (reason && THROTTLE_REASONS.has(reason))) {
        throw new HttpException(
          {
            error: {
              code: 'RECOVERY_THROTTLED',
              message:
                'Mashov is rate limiting recovery for this account. Please try again later.',
              details: [],
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // A 5xx is Mashov being broken, not an unknown account. Fabricating a
      // recovery here would have the parent wait for an email that was never
      // going to be sent.
      if (status === undefined || status >= 500) {
        throw upstreamError();
      }

      // Everything else -- IdNumberNoMatch, NotContactInSchool, BindNotFound,
      // UserInactive*, MfaContactMissing, UserSuspended, any unmapped 4xx --
      // becomes an indistinguishable success.
      poisoned = true;
    }

    const recoveryId = randomUUID();
    const state: RecoveryState = {
      semel: Number(input.semel),
      idNumber: input.idNumber,
      channel: input.channel,
      isResettingAndVerifying,
      attempts: 0,
      poisoned,
    };
    await this.writeState(recoveryId, state);

    // Field order is fixed here, not built conditionally: the JSON body for an
    // unknown ID has to be byte-identical to a real one's.
    return {
      recoveryId,
      requiresSecondChannel: isResettingAndVerifying,
      channel: input.channel,
    };
  }

  /**
   * Step 2: set the new password.
   *
   * Order is load-bearing. Attempt counting and password validation happen
   * BEFORE the poisoned check and before any upstream call, so a fabricated
   * recovery behaves identically to a real one with a wrong code — and so a
   * policy violation can never be mistaken for a bad code upstream, where
   * Mashov answers 404 for both.
   */
  async completePassword(
    recoveryId: string,
    input: CompletePasswordInput,
    ip: string,
  ): Promise<CompletePasswordResult> {
    const key = stateKey(recoveryId);
    const state = await this.readState(key);

    if (!state) {
      // Deliberately its own code rather than INVALID_RECOVERY_CODE: the
      // `recoveryId` is ours, opaque and single-use, so saying "this handle is
      // gone, start again" leaks nothing and is the difference between a
      // usable screen and a parent retyping a correct code.
      throw new HttpException(
        {
          error: {
            code: 'RECOVERY_SESSION_EXPIRED',
            message: 'This recovery has expired. Please start again.',
            details: [],
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (state.attempts >= MAX_CODE_ATTEMPTS) {
      await this.redis.del(key);
      throw new HttpException(
        {
          error: {
            code: 'RECOVERY_LOCKED',
            message: 'Too many attempts. Please start the recovery again.',
            details: [],
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The username rule is relational, and for these accounts the Mashov
    // username IS the ID number.
    assertPasswordPolicy(input.newPassword, state.idNumber);

    if (state.isResettingAndVerifying && !input.secondCode?.trim()) {
      throw new HttpException(
        {
          error: {
            code: 'SECOND_CODE_REQUIRED',
            message: 'Mashov sent a code to both channels; both are required.',
            details: [],
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.writeState(recoveryId, { ...state, attempts: state.attempts + 1 });

    if (state.poisoned) {
      throw invalidRecoveryCode();
    }

    let username: string | undefined;
    try {
      const result = state.isResettingAndVerifying
        ? await this.upstream.resetPasswordVerify(
            input.code,
            input.secondCode,
            input.newPassword,
          )
        : await this.upstream.resetPassword(input.code, input.newPassword);
      username = result.username;
    } catch (err) {
      throw this.classifyResetFailure(err, state.semel);
    }

    // Single use: the state is consumed only once the reset actually landed, so
    // a wrong code leaves the parent able to retry with the right one.
    await this.redis.del(key);
    await this.writeAudit(state, ip);
    await this.markCredentialStale(state);

    return { ok: true, username };
  }

  /**
   * The password we have stored for this connection no longer works.
   *
   * Without this the breakage is SILENT: the sixteen sync crons keep decrypting
   * a password Mashov has already replaced, and the parent just sees their data
   * stop updating with nothing to tell them why.
   *
   * Two steps, and the second is the one that is easy to forget. The mark is
   * what `MeSchool.credentialStale` renders. The eviction is what stops the
   * crons: the in-memory session cache is keyed `${connectionId}:${year}` and
   * outlives the reset, so without it they go on using a session authenticated
   * with a password that no longer exists. `connection.service.ts` already does
   * the same eviction on unlink.
   *
   * Best-effort, and deliberately so: `idNumber` IS the Mashov username for
   * these accounts (a login response carries `credential.idNumber: 303977367`
   * next to `accessToken.username: "303977367"`), and `HouseholdConnection` is
   * uniquely keyed on `[schoolCode, username]` -- but a parent who set a custom
   * username through `CreateUsername` will not match. Their reset must still
   * work.
   *
   * Never raised. The password has ALREADY changed upstream, on a single-use
   * code. Failing the request now would tell the parent their reset did not
   * work when it did, and they could not repeat it.
   */
  private async markCredentialStale(state: RecoveryState): Promise<void> {
    try {
      const connection = await this.prisma.householdConnection.findUnique({
        where: {
          schoolCode_username: { schoolCode: state.semel, username: state.idNumber },
        },
        select: { id: true },
      });

      if (!connection) {
        this.logger.log(
          `Reset completed for semel=${state.semel} with no matching connection; nothing to mark`,
        );
        return;
      }

      await this.prisma.householdConnection.update({
        where: { id: connection.id },
        data: { credentialStaleAt: new Date() },
      });

      this.sessionService.invalidateConnection(connection.id);
    } catch (err) {
      this.logger.error(
        `Failed to mark connection stale after a reset for semel=${state.semel}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Upstream failure → our envelope, for step 2 only.
   *
   * The one rule that matters: a transport failure must NEVER render as an
   * invalid code. The parent has already burned a single-use code, so a false
   * "wrong code" is unrecoverable — they cannot ask for that code again.
   */
  private classifyResetFailure(err: unknown, semel: number): HttpException {
    if (isUpstreamUnreachable(err)) {
      this.logger.error(
        `Mashov reset unreachable for semel=${semel}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return upstreamError();
    }

    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const reason = readReason(err);

    switch (reason) {
      case 'MfaCodeExpired':
      case 'MfaExpired':
        return new HttpException(
          {
            error: {
              code: 'RECOVERY_CODE_EXPIRED',
              message: 'That code has expired. Please start the recovery again.',
              details: [],
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      case 'MfaInvalidCode':
        return invalidRecoveryCode();
      case 'MfaLocked':
        return new HttpException(
          {
            error: {
              code: 'RECOVERY_LOCKED',
              message: 'Too many attempts. Please start the recovery again.',
              details: [],
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'UserSuspended':
        // Unlike step 1, this is NOT an oracle: the caller already holds a
        // recoveryId, so they learn nothing new about whether the ID exists.
        return new HttpException(
          {
            error: {
              code: 'CAPTCHA_REQUIRED',
              message: 'Mashov is asking for a captcha before this reset can complete',
              details: [],
            },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      default:
        break;
    }

    // 404 means a bad code — and ONLY because `assertPasswordPolicy` already
    // ran. Mashov answers 404 for a policy violation too.
    if (status !== undefined && status >= 400 && status < 500) {
      return invalidRecoveryCode();
    }

    return upstreamError();
  }

  private async checkIpRateLimit(ip: string): Promise<void> {
    await this.countAgainstLimit(
      `ratelimit:recovery:${ip}`,
      IP_LIMIT,
      IP_WINDOW_SECONDS,
    );
  }

  private async checkIdentityRateLimit(semel: number, idNumber: string): Promise<void> {
    // Hashed: a raw key would park a national ID number under a greppable
    // Redis key, readable by anything with Redis access.
    await this.countAgainstLimit(
      `ratelimit:recovery:id:${Number(semel)}:${sha256(idNumber)}`,
      ID_LIMIT,
      ID_WINDOW_SECONDS,
    );
  }

  private async countAgainstLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      throw new HttpException(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many recovery attempts. Please try again later.',
            details: [],
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async writeState(recoveryId: string, state: RecoveryState): Promise<void> {
    // The TTL is refreshed on each attempt deliberately: a parent working
    // through a two-code form should not have the handle expire under them.
    await this.redis.set(
      stateKey(recoveryId),
      JSON.stringify(state),
      RECOVERY_TTL_SECONDS,
    );
  }

  private async readState(key: string): Promise<RecoveryState | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RecoveryState;
    } catch {
      // A corrupt value is indistinguishable from an expired one as far as the
      // caller is concerned, and guessing at it would be worse.
      return null;
    }
  }

  private async writeAudit(state: RecoveryState, ip: string): Promise<void> {
    try {
      await this.prisma.credentialRecoveryAudit.create({
        data: {
          schoolCode: state.semel,
          idNumberHash: sha256(state.idNumber),
          ip,
        },
      });
    } catch (err) {
      // The password has already been changed upstream. Failing the request
      // now would tell the parent their reset did not work when it did, and
      // the code is single-use, so they could not repeat it.
      this.logger.error(
        `Failed to write the recovery audit row for semel=${state.semel}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}

function stateKey(recoveryId: string): string {
  return `recovery:${recoveryId}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidRecoveryCode(): HttpException {
  return new HttpException(
    {
      error: {
        code: 'INVALID_RECOVERY_CODE',
        message: 'That code is not valid.',
        details: [],
      },
    },
    HttpStatus.BAD_REQUEST,
  );
}

function upstreamError(): HttpException {
  return new HttpException(
    {
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Mashov is not reachable right now. Please try again shortly.',
        details: [],
      },
    },
    HttpStatus.BAD_GATEWAY,
  );
}
