import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { isUpstreamUnreachable } from '../common/http/mashov-http';
import { MashovRecoveryService } from '../common/mashov-login/mashov-recovery.service';
import { assertPasswordPolicy } from '../common/mashov-login/password-policy';
import {
  describeMashovFailure,
  isMashovRejection,
  readReason,
  type MashovReason,
} from '../common/mashov-login/mashov-reason';
import { EncryptionService } from '../session/encryption.service';
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

/**
 * The upstream path, as a literal for the log line. Never read from
 * `err.config?.url` -- see `describeMashovFailure`: `resetPassword` puts a
 * single-use recovery code in the path, so a log line built from the request
 * URL would write live recovery codes to disk.
 */
const RECOVER_PATH = '/api/user/recover';

/**
 * The two step-2 paths, as literals with the code elided.
 *
 * Same reasoning as `RECOVER_PATH`, and it matters more here: the single-use
 * recovery code is IN the path on both of these routes, so a log line built
 * from `err.config?.url` would write live codes to disk. `{code}` is a
 * placeholder, never interpolated.
 *
 * Which of the two appears in a log line is itself a diagnostic: posting the
 * single-code route for an account Mashov wants two codes for is one of the
 * candidate causes of a 404, and nothing else distinguishes it.
 */
const RESET_PATH = '/api/user/reset/{code}';
const RESET_VERIFY_PATH = '/api/user/reset/verify/{code}';

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
  /**
   * The email address or mobile number the code goes to.
   *
   * Required, because Mashov requires it: the parent types it and Mashov
   * refuses unless it matches what the school holds. The earlier design
   * assumed Mashov would send to a contact it already had, which is true of
   * the OTP and MFA flows but not of this one.
   */
  destination: string;
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
  /**
   * Mashov's username for the account. A parent who forgot the password often
   * forgot this too.
   *
   * Always set, and usually DERIVED rather than reported: the capture of
   * `POST /api/user/reset/{code}` returned an empty body, so upstream names the
   * username on no observed success. `completePassword` falls back to the
   * recovering `idNumber`, which IS the Mashov username for these accounts.
   * Not `| undefined` any more, because a client that gates on it was gating on
   * something that never arrived.
   */
  username: string;
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
  // No `channel`. It was written here and never read back -- every use is
  // `input.channel` on the request that writes it -- while the docblock above
  // claimed it was part of "what survives between the two steps". Step 2 takes
  // the codes and the new password; which channel sent them is not its
  // business. Removed rather than left as a comfortable-looking field.
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
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * A keyed, non-reversible handle on an identity.
   *
   * NOT a bare `sha256(idNumber)`. An Israeli ID number is about 10^9
   * candidates, so a plain digest is a rainbow table away from the original --
   * which would defeat both things the hash is for: keeping a national
   * identifier out of a greppable Redis key, and out of a support-readable
   * audit table. Keyed with the deploy's own secret, it is still stable enough
   * to count resets per identity and join two attempts together.
   */
  private identityHash(idNumber: string): string {
    return createHmac('sha256', this.encryption.hashKey())
      .update(idNumber)
      .digest('hex');
  }

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
        // The field NAME is the channel; the value is the address. Never a
        // boolean -- see `RequestRecoveryInput`.
        ...(input.channel === 'sms'
          ? { cellphone: input.destination }
          : { email: input.destination }),
      });
      isResettingAndVerifying = result.isResettingAndVerifying === true;

      // Logged on SUCCESS, which is the counter-intuitive half and the reason
      // this flow had no diagnosis.
      //
      // The likeliest cause of "no email arrived" is not a refusal at all: the
      // channel flag's type is the one thing `apis/post-api-user-recover.md`
      // admits it never confirmed, and a Mashov that ignores an unknown-typed
      // flag answers 200 having sent nothing. No exception is thrown, so every
      // log line in the `catch` below -- including the one this change adds --
      // stays silent, and the parent is told to check an inbox nothing went to.
      // `status=200 isResettingAndVerifying=absent` is that failure's
      // fingerprint, and nothing else records it.
      //
      // Key NAMES only, never values: the keys are Mashov's schema and are the
      // diagnostic, while the body may carry a masked address or phone number.
      this.logger.log(
        `Mashov recovery accepted: semel=${input.semel} channel=${input.channel} ` +
          `isResettingAndVerifying=${
            result.isResettingAndVerifying === undefined
              ? 'absent'
              : String(result.isResettingAndVerifying)
          } responseKeys=[${Object.keys(result ?? {}).sort().join(',')}]`,
      );
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
        this.logger.warn(
          `Mashov recovery failed upstream: ${describeMashovFailure(err, {
            stage: `recover:${input.channel}`,
            semel: input.semel,
            path: RECOVER_PATH,
          })}`,
        );
        throw upstreamError();
      }

      // A 4xx that did not come from Mashov's API is not evidence about this
      // account at all -- it is a proxy ACL or a WAF between us and them.
      // Fabricating a recovery for it would have the parent wait for an email
      // nobody was ever going to send.
      if (!isMashovRejection(err)) {
        this.logger.error(
          `Mashov recovery answered ${status} without Mashov's own signature for semel=${input.semel}; treating as an outage`,
        );
        throw upstreamError();
      }

      // Everything else -- IdNumberNoMatch, NotContactInSchool, BindNotFound,
      // UserInactive*, MfaContactMissing, UserSuspended, any unmapped 4xx --
      // becomes an indistinguishable success.
      //
      // The RESPONSE stays indistinguishable, because that is what keeps an
      // attacker from using this route to test whether an ID number belongs to
      // a real parent. The LOG does not, because the silence protected nobody:
      // it was the response that needed to be uninformative, and the
      // anti-enumeration reasoning was applied to our own telemetry by
      // accident. A parent reporting "no email arrived" had nothing to read.
      //
      // `semel` only -- never `idNumber`. It is an Israeli national ID number,
      // the thing ADR-0042 §9's HMAC'd rate-limit keys exist to keep out of
      // plaintext, and `describeMashovFailure` structurally cannot reach it.
      // Not an HMAC of it either: the key lives in this process and the domain
      // is ~10^9, so a "correlation hash" in a log file is the ID number.
      this.logger.warn(
        `Mashov recovery refused, answering an indistinguishable 202: ${describeMashovFailure(
          err,
          {
            stage: `recover:${input.channel}`,
            semel: input.semel,
            path: RECOVER_PATH,
          },
        )}`,
      );

      poisoned = true;
    }

    const recoveryId = randomUUID();
    const state: RecoveryState = {
      semel: Number(input.semel),
      idNumber: input.idNumber,
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

    const attempt = state.attempts + 1;
    const path = state.isResettingAndVerifying ? RESET_VERIFY_PATH : RESET_PATH;

    if (state.poisoned) {
      // The cause that is invisible from Mashov's side, because there is no
      // call to Mashov: step 1 refused this identity, answered an
      // indistinguishable 202 with a fabricated handle, and step 2 now refuses
      // every code against it. A parent who typo'd their email address is told
      // "that code is not valid" about a code they may genuinely be holding.
      //
      // The RESPONSE stays indistinguishable -- that is ADR-0042's deliberate
      // anti-enumeration choice. The LOG does not: the silence here protected
      // nobody and left three different causes looking identical. Same split
      // step 1 made in 2e34067.
      //
      // `semel` and the attempt number only. Never `idNumber`, and not an HMAC
      // of it: see the reasoning at the step-1 refusal log above.
      this.logger.warn(
        `Mashov reset refused without calling Mashov: the step-1 handle is ` +
          `poisoned (unknown identity or an upstream refusal at step 1), so no ` +
          `code can ever match it; semel=${state.semel} attempt=${attempt}/` +
          `${MAX_CODE_ATTEMPTS} path=${path}`,
      );
      throw invalidRecoveryCode();
    }

    let upstreamUsername: string | undefined;
    try {
      const result = state.isResettingAndVerifying
        ? await this.upstream.resetPasswordVerify(
            input.code,
            input.secondCode,
            input.newPassword,
          )
        : await this.upstream.resetPassword(input.code, input.newPassword);
      upstreamUsername = result.username;
    } catch (err) {
      throw this.classifyResetFailure(err, state.semel, path, attempt);
    }

    // Reaching here IS the success signal, and deliberately not a field read.
    // The capture records an EMPTY response body on a successful reset, and an
    // empty body is also exactly the shape of a dead connection -- only the
    // status separates them, and axios has already thrown on a non-2xx.
    //
    // `username` therefore falls back to the ID number. The reasoning is the
    // one `markCredentialStale` already relies on: `idNumber` IS the Mashov
    // username for these accounts, and `HouseholdConnection` is uniquely keyed
    // `[schoolCode, username]` on that basis. Same `CreateUsername` caveat --
    // a parent who set a custom username will get the ID number instead -- so
    // an upstream answer always wins when there is one. DERIVED, not reported.
    //
    // Without the fallback the client's auto sign-in, which is gated on this
    // field, never fires on any real reset, and the "your username is..." line
    // never renders.
    const username = upstreamUsername ?? state.idNumber;

    // Single use: the state is consumed only once the reset actually landed, so
    // a wrong code leaves the parent able to retry with the right one.
    await this.redis.del(key);
    await this.writeAudit(state, ip);
    await this.markCredentialStale(state);

    // The counter-intuitive half, as at step 1: a success leaves a trace too.
    // `upstreamUsername` is the one thing here that is a fact about the wire
    // rather than about us, and it is how we learn whether the capture's empty
    // body is universal or specific to that account.
    this.logger.log(
      `Mashov reset accepted: semel=${state.semel} ` +
        `twoChannel=${state.isResettingAndVerifying} path=${path} ` +
        `attempt=${attempt} upstreamUsername=${
          upstreamUsername === undefined ? 'absent' : 'present'
        }`,
    );

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
  private classifyResetFailure(
    err: unknown,
    semel: number,
    path: string,
    attempt: number,
  ): HttpException {
    if (isUpstreamUnreachable(err)) {
      this.logger.error(
        `Mashov reset unreachable for semel=${semel} path=${path} attempt=${attempt}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return upstreamError();
    }

    const outcome = this.mapResetFailure(err);

    // The line step 2 never had. Three causes -- a poisoned handle, a bare
    // upstream 404, and `Reason: MfaInvalidCode` -- all render as
    // INVALID_RECOVERY_CODE, and until now none of them left a trace, so a
    // report of "the code Mashov sent me is rejected" could not be answered.
    //
    // `path` is the LITERAL constant above, never the failed request's own URL:
    // the single-use code is in the request path, so a line built from the URL
    // would write live codes to disk. `describeMashovFailure` structurally
    // cannot reach the code, the password or the ID number.
    this.logger.warn(
      `Mashov reset refused, answering ${outcome.code}: ${describeMashovFailure(err, {
        stage: 'reset',
        semel,
        path,
      })} attempt=${attempt}/${MAX_CODE_ATTEMPTS}`,
    );

    return outcome.exception;
  }

  /**
   * The mapping itself, split out so the log line above can name the outcome
   * it is about to return without the switch having to log in six places.
   */
  private mapResetFailure(err: unknown): { code: string; exception: HttpException } {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const reason = readReason(err);

    switch (reason) {
      case 'MfaCodeExpired':
      case 'MfaExpired':
        return {
          code: 'RECOVERY_CODE_EXPIRED',
          exception: new HttpException(
            {
              error: {
                code: 'RECOVERY_CODE_EXPIRED',
                message: 'That code has expired. Please start the recovery again.',
                details: [],
              },
            },
            HttpStatus.BAD_REQUEST,
          ),
        };
      case 'MfaInvalidCode':
        return { code: 'INVALID_RECOVERY_CODE', exception: invalidRecoveryCode() };
      case 'MfaLocked':
        return {
          code: 'RECOVERY_LOCKED',
          exception: new HttpException(
            {
              error: {
                code: 'RECOVERY_LOCKED',
                message: 'Too many attempts. Please start the recovery again.',
                details: [],
              },
            },
            HttpStatus.TOO_MANY_REQUESTS,
          ),
        };
      case 'UserSuspended':
        // Unlike step 1, this is NOT an oracle: the caller already holds a
        // recoveryId, so they learn nothing new about whether the ID exists.
        return {
          code: 'CAPTCHA_REQUIRED',
          exception: new HttpException(
            {
              error: {
                code: 'CAPTCHA_REQUIRED',
                message: 'Mashov is asking for a captcha before this reset can complete',
                details: [],
              },
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
          ),
        };
      default:
        break;
    }

    // 404 means a bad code — and only on two conditions. One:
    // `assertPasswordPolicy` already ran, because Mashov answers 404 for a
    // policy violation too. Two: the answer actually came from Mashov's API.
    // Our egress is a residential proxy, and a proxy ACL rejection is a 403
    // with an HTML body and no `Reason` — reported as a bad code, it tells the
    // parent their single-use code was wrong, which they cannot recover from.
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      isMashovRejection(err)
    ) {
      return { code: 'INVALID_RECOVERY_CODE', exception: invalidRecoveryCode() };
    }

    return { code: 'UPSTREAM_ERROR', exception: upstreamError() };
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
      `ratelimit:recovery:id:${Number(semel)}:${this.identityHash(idNumber)}`,
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
    // Encrypted, not plain JSON: the state carries the `idNumber`, and a plain
    // value means `SCAN recovery:* ` plus `GET` dumps every in-flight
    // recovery's national ID to anything with Redis access. The same
    // `EncryptionService` that protects `encryptedPassword`.
    //
    // The TTL is refreshed on each attempt deliberately: a parent working
    // through a two-code form should not have the handle expire under them.
    await this.redis.set(
      stateKey(recoveryId),
      this.encryption.encrypt(JSON.stringify(state)),
      RECOVERY_TTL_SECONDS,
    );
  }

  private async readState(key: string): Promise<RecoveryState | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(this.encryption.decrypt(raw)) as RecoveryState;
    } catch {
      // A value we cannot decrypt or parse is indistinguishable from an expired
      // one as far as the caller is concerned -- including a plaintext value
      // left by a previous deploy -- and guessing at it would be worse. The
      // parent is told to start again, which is true.
      return null;
    }
  }

  private async writeAudit(state: RecoveryState, ip: string): Promise<void> {
    try {
      await this.prisma.credentialRecoveryAudit.create({
        data: {
          schoolCode: state.semel,
          idNumberHash: this.identityHash(state.idNumber),
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
