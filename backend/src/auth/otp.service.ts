import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { isUpstreamUnreachable } from '../common/http/mashov-http';
import { buildLoginBody } from '../common/mashov-login/mashov-login-body';
import {
  MashovRecoveryService,
  type MfaMethod,
} from '../common/mashov-login/mashov-recovery.service';
import { isMashovRejection, readReason } from '../common/mashov-login/mashov-reason';
import { countAgainstLimit, identityKeyHash } from '../common/mashov-login/rate-limit';
import { AuthService } from './auth.service';

/**
 * Passwordless sign-in by one-time code, mirroring Mashov's own `loginMethod`
 * switch (`password` | `email` | `sms`).
 *
 * ## It cannot replace password sign-in, and that is enforced here
 *
 * Sixteen cron tasks keep a household's data fresh by decrypting its stored
 * credential and re-logging in. A household that only ever signed in by OTP
 * would have no stored credential, so it would get a working session and no
 * background data at all -- the app would look fine and quietly never update.
 *
 * Rather than let that ship silently, this service REFUSES an OTP sign-in for
 * a school with no existing connection, with its own code
 * (`PASSWORD_SIGN_IN_REQUIRED`) so the UI can say exactly that. For a school
 * that has been signed into before, the already-stored password is re-written
 * on the way through, which keeps the column populated without inventing a
 * credential we were never given.
 *
 * The alternative considered was marking such a connection `credentialStale`
 * and letting the banner explain it. Refusing up front is better: it happens
 * before a code is sent, so the parent is not left holding a code they cannot
 * use.
 */

const OTP_TTL_SECONDS = 900;
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 900;
/** Per identity, because the 409 this route can answer is a membership oracle. */
const IDENTITY_LIMIT = 5;
const IDENTITY_WINDOW_SECONDS = 3600;
const MAX_CODE_ATTEMPTS = 5;

interface OtpState {
  semel: number;
  username: string;
  method: MfaMethod;
  attempts: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
    private readonly schoolYearService: SchoolYearService,
    private readonly upstream: MashovRecoveryService,
  ) {}

  /** Step 1: ask Mashov for a code, and hand back an opaque handle. */
  async request(
    input: { semel: number; username: string; method: MfaMethod },
    ip: string,
  ): Promise<{ otpRequestId: string; method: MfaMethod }> {
    const semel = Number(input.semel);

    await countAgainstLimit(this.redis, `ratelimit:otp:${ip}`, IP_LIMIT, IP_WINDOW_SECONDS);
    // Per identity as well, and it matters more here than the per-IP bucket:
    // the 409 below tells the caller whether that person uses our app at all,
    // so this route is a membership oracle keyed on an ID number. Per-IP alone
    // does nothing against a botnet walking a list. Hashed, for the same reason
    // the recovery key is.
    await countAgainstLimit(
      this.redis,
      `ratelimit:otp:id:${semel}:${identityKeyHash(
        this.encryption.hashKey(),
        input.username,
      )}`,
      IDENTITY_LIMIT,
      IDENTITY_WINDOW_SECONDS,
    );

    // Checked BEFORE a code is sent, so the parent is never left holding a
    // code they cannot use.
    await this.requireExistingConnection(semel, input.username);

    try {
      await this.upstream.requestOtp({
        semel,
        username: input.username,
        method: input.method,
      });
    } catch (err) {
      throw this.classify(err, 'request', semel);
    }

    const otpRequestId = randomUUID();
    await this.writeState(otpRequestId, {
      semel,
      username: input.username,
      method: input.method,
      attempts: 0,
    });

    return { otpRequestId, method: input.method };
  }

  /** Step 2: exchange the code for a session. */
  async createSession(
    otpRequestId: string,
    input: { code: string },
    ip: string,
  ): Promise<{ sessionToken: string; isFirstLogin: boolean }> {
    const key = stateKey(otpRequestId);
    const state = await this.readState(key);

    if (!state) {
      throw envelope(
        'OTP_SESSION_EXPIRED',
        'This sign-in has expired. Please ask for a new code.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (state.attempts >= MAX_CODE_ATTEMPTS) {
      await this.redis.del(key);
      throw envelope(
        'OTP_LOCKED',
        'Too many attempts. Please ask for a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Re-checked: the connection could have been unlinked between the two
    // steps, and minting a session with no credential is the thing this whole
    // class exists to prevent.
    const connection = await this.requireExistingConnection(
      state.semel,
      state.username,
    );

    await this.writeState(otpRequestId, { ...state, attempts: state.attempts + 1 });

    const resolved = await this.schoolYearService.resolveForSchool(state.semel);

    let result;
    try {
      result = await this.upstream.verifyOtp({
        // No password, by construction: `buildLoginBody` omits the field when
        // none is supplied, and `verifyOtp` strips it again anyway.
        loginData: buildLoginBody({
          semel: state.semel,
          year: resolved.year,
          username: state.username,
        }),
        code: input.code,
      });
    } catch (err) {
      throw this.classify(err, 'verify', state.semel);
    }

    if (!result.data?.credential?.userId) {
      this.logger.error(
        `OTP verify for semel=${state.semel} returned no credential.userId; refusing to mint a session`,
      );
      throw envelope(
        'INVALID_OTP_CODE',
        'Mashov did not complete the sign-in. Please try again.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.redis.del(key);

    return this.authService.persistSessionFromLogin({
      semel: state.semel,
      username: state.username,
      // The password we already hold, decrypted and re-encrypted on the way
      // through. There is no password in this flow, and `encryptedPassword` is
      // what the crons read, so the alternative is a column we have to make
      // nullable and sixteen call sites that have to cope.
      password: this.encryption.decrypt(connection.encryptedPassword),
      year: resolved.year,
      loginData: result.data,
      newUniqueId: result.newUniqueId,
      devicePass: result.devicePass,
      // NOT proven: this is the password we already had, which may be exactly
      // the dead one a recovery reset invalidated. Clearing the stale flag here
      // would delete the only signal saying this school's sync is broken.
      credentialProven: false,
      ip,
      existingConnBeforeLogin: {
        id: connection.id,
        mashovUniqueId: connection.mashovUniqueId,
        userId: connection.userId,
      },
    });
  }

  /**
   * The connection whose stored password keeps this household's sync alive, or
   * a refusal that says so.
   */
  private async requireExistingConnection(semel: number, username: string) {
    const connection = await this.prisma.householdConnection.findUnique({
      where: { schoolCode_username: { schoolCode: semel, username } },
      select: {
        id: true,
        mashovUniqueId: true,
        userId: true,
        encryptedPassword: true,
      },
    });

    if (!connection) {
      throw envelope(
        'PASSWORD_SIGN_IN_REQUIRED',
        'The first sign-in for a school has to use a password, so background updates keep working.',
        HttpStatus.CONFLICT,
      );
    }

    return connection;
  }

  private async writeState(otpRequestId: string, state: OtpState): Promise<void> {
    await this.redis.set(stateKey(otpRequestId), JSON.stringify(state), OTP_TTL_SECONDS);
  }

  private async readState(key: string): Promise<OtpState | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OtpState;
    } catch {
      return null;
    }
  }

  /** Never 401, and never a wrong-code answer for a transport failure. */
  private classify(
    err: unknown,
    stage: 'request' | 'verify',
    semel: number,
  ): HttpException {
    if (isUpstreamUnreachable(err)) {
      this.logger.error(
        `Mashov OTP ${stage} unreachable for semel=${semel}: ${
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
          'INVALID_OTP_CODE',
          'That code is not valid.',
          HttpStatus.BAD_REQUEST,
        );
      case 'MfaCodeExpired':
      case 'MfaExpired':
        return envelope(
          'OTP_CODE_EXPIRED',
          'That code has expired. Please ask for a new one.',
          HttpStatus.BAD_REQUEST,
        );
      case 'MfaLocked':
        return envelope(
          'OTP_LOCKED',
          'Too many attempts. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'MfaResendTooSoon':
        return envelope(
          'OTP_RESEND_TOO_SOON',
          'A code was just sent. Please wait before asking for another.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'MfaContactMissing':
        return envelope(
          'OTP_CONTACT_MISSING',
          'Mashov has no email address or phone number on file for this account.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      case 'LoginMethodBlocked':
        return envelope(
          'LOGIN_METHOD_BLOCKED',
          'This school does not allow signing in without a password.',
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
      // Only Mashov's API gets to call a code invalid; a proxy ACL page does
      // not.
      isMashovRejection(err)
    ) {
      return envelope(
        'INVALID_OTP_CODE',
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

function stateKey(otpRequestId: string): string {
  return `otp:${otpRequestId}`;
}

function envelope(code: string, message: string, status: HttpStatus): HttpException {
  return new HttpException({ error: { code, message, details: [] } }, status);
}
