import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import {
  createMashovAxios,
  resolveMashovBaseUrl,
} from '../http/mashov-http';
import { MASHOV_CSRF_TOKEN } from './mashov-login-body';
import { readLoginHeaders } from './mashov-login-headers';
import type { MashovLoginPayload } from './mashov-credential-validator.service';

/**
 * The upstream half of password recovery, MFA and trusted-device re-login.
 *
 * Deliberately thin: one POST per method, no Prisma, no Redis, no policy, no
 * error classification. Everything that decides what a failure *means* lives
 * in `credential-recovery.service.ts`, because the answers differ per surface
 * (`UserSuspended` is a captcha prompt on sign-in and an enumeration oracle on
 * recovery step 1) and because the orchestration is where the rate limits and
 * the no-enumeration rules belong.
 *
 * ## Secrecy
 *
 * This class handles single-use recovery codes, OTP codes and plaintext new
 * passwords. None of them may be persisted anywhere — not Redis, not a log
 * line, not a breadcrumb, not an exception message. There is deliberately NO
 * logger on this class: a logger is the easiest way to leak one of these by
 * accident, and a spec asserts that no log line here interpolates a secret.
 */
@Injectable()
export class MashovRecoveryService {
  private readonly baseUrl: string;
  /** Shared Mashov client: applies the egress proxy and the abort-signal timeout. */
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = resolveMashovBaseUrl(
      this.configService.get<string>('MASHOV_BASE_URL'),
    );
    this.http = createMashovAxios(this.baseUrl);
  }

  /**
   * Step 1 of recovery: ask Mashov to send a code.
   *
   * `email` / `cellphone` pick the channel. They are passed through verbatim
   * as the shape read off the bundle; the caller decides which one to set.
   * `isResettingAndVerifying` in the response means Mashov sent codes on BOTH
   * channels and the reset needs both of them — which is why the flag is kept
   * server-side rather than trusted from the client on step 2.
   */
  async requestRecovery(input: RequestRecoveryInput): Promise<RequestRecoveryResult> {
    const body: Record<string, unknown> = {
      semel: Number(input.semel),
      idNumber: input.idNumber,
    };
    if (input.email !== undefined) body.email = input.email;
    if (input.cellphone !== undefined) body.cellphone = input.cellphone;

    const response = await this.http.post<RequestRecoveryResult>(
      '/api/user/recover',
      body,
      { headers: this.headers() },
    );
    return response.data ?? {};
  }

  /**
   * Step 2, single channel. `404` from here means a bad code — but only
   * because the caller already enforced the password policy, since Mashov
   * answers 404 for a policy violation too.
   */
  async resetPassword(code: string, newPassword: string): Promise<ResetResult> {
    const response = await this.http.post<ResetResult>(
      `/api/user/reset/${pathSegment(code)}`,
      { newPassword },
      { headers: this.headers() },
    );
    return response.data ?? {};
  }

  /**
   * Step 2, two-channel variant. A blank or missing second code posts the
   * one-segment path: `/verify/AAA111/` is a different upstream route from
   * `/verify/AAA111`.
   */
  async resetPasswordVerify(
    code: string,
    secondCode: string | undefined,
    newPassword: string,
  ): Promise<ResetResult> {
    const first = pathSegment(code);
    const second = secondCode ? pathSegment(secondCode) : '';
    const path = second
      ? `/api/user/reset/verify/${first}/${second}`
      : `/api/user/reset/verify/${first}`;

    const response = await this.http.post<ResetResult>(
      path,
      { newPassword },
      { headers: this.headers() },
    );
    return response.data ?? {};
  }

  /** Ask Mashov to (re)send an MFA code on one channel. */
  async sendMfa(challengeId: string, method: MfaMethod): Promise<void> {
    await this.http.post('/api/login/mfa/send', { challengeId, method }, {
      headers: this.headers(),
    });
  }

  /**
   * Answer an MFA challenge, and get a session.
   *
   * `password`, `newPassword`, `captcha` and `mfaChallengeId` are stripped
   * from the login data first, exactly as Mashov's own client does — this
   * route rejects them.
   *
   * `rememberBrowser: true` is what makes Mashov issue the `devicePass` in the
   * response. Without it an MFA account signs in once and then every cron
   * re-login re-triggers the challenge, so sync dies the next morning.
   */
  async verifyMfa(input: VerifyMfaInput): Promise<MashovLoginResponseView> {
    const body = {
      ...stripLoginSecrets(input.loginData),
      challengeId: input.challengeId,
      code: stripWhitespace(input.code),
      rememberBrowser: input.rememberBrowser,
    };

    const response = await this.http.post<MashovLoginPayload>(
      '/api/login/mfa/verify',
      body,
      { headers: this.headers() },
    );

    return { data: response.data, ...readLoginHeaders(response.headers) };
  }

  /**
   * Trusted-device re-login: a session without re-answering MFA.
   *
   * This is the load-bearing piece of MFA support. The response may carry a
   * rotated `devicePass`, which the caller must persist, or the next re-login
   * fails and sync falls back to the password it may no longer have.
   */
  async loginDevice(
    devicePass: string,
    uniqueId?: string | null,
  ): Promise<MashovLoginResponseView> {
    const response = await this.http.post<MashovLoginPayload>(
      '/api/loginDevice',
      {},
      { headers: this.headers({ devicePass }, uniqueId) },
    );

    return { data: response.data, ...readLoginHeaders(response.headers) };
  }


  /**
   * Authenticated password change: the forced-change path.
   *
   * Driven by `403 Reason: ChangePass` (or `SetUsernameAndPass`), where the
   * parent's password is CORRECT but Mashov will not let them in until they
   * replace it. The login body keeps the CURRENT password -- this route proves
   * it before changing it -- and the challenge id from that 403 is echoed back
   * under its request-side name, `mfaChallengeId`.
   */
  async changePassword(input: {
    loginData: Record<string, unknown>;
    newPassword: string;
    challengeId?: string;
    /** See `uniqueId` on `headers()` below. */
    uniqueId?: string | null;
  }): Promise<MashovLoginResponseView> {
    const response = await this.http.post<MashovLoginPayload>(
      '/api/user/password',
      {
        ...input.loginData,
        newPassword: input.newPassword,
        ...(input.challengeId ? { mfaChallengeId: input.challengeId } : {}),
      },
      { headers: this.headers({}, input.uniqueId) },
    );
    return { data: response.data, ...readLoginHeaders(response.headers) };
  }

  /**
   * Authenticated username change, for `CreateUsername` /
   * `SetUsernameAndPass`.
   *
   * Identical shape to the password change, with the NEW username replacing the
   * one in the login body -- Mashov reads the field, not a separate parameter.
   */
  async changeUsername(input: {
    loginData: Record<string, unknown>;
    username: string;
    challengeId?: string;
    /** See `uniqueId` on `headers()` below. */
    uniqueId?: string | null;
  }): Promise<MashovLoginResponseView> {
    const response = await this.http.post<MashovLoginPayload>(
      '/api/user/username',
      {
        ...input.loginData,
        username: input.username,
        ...(input.challengeId ? { mfaChallengeId: input.challengeId } : {}),
      },
      { headers: this.headers({}, input.uniqueId) },
    );
    return { data: response.data, ...readLoginHeaders(response.headers) };
  }

  /** Step 1 of passwordless sign-in: ask for a one-time code. */
  async requestOtp(input: {
    semel: number;
    username: string;
    method: MfaMethod;
    /** See `uniqueId` on `headers()` below. */
    uniqueId?: string | null;
  }): Promise<void> {
    await this.http.post(
      '/api/user/otp/request',
      { semel: Number(input.semel), username: input.username, method: input.method },
      { headers: this.headers({}, input.uniqueId) },
    );
  }

  /**
   * Step 2 of passwordless sign-in: exchange the code for a session.
   *
   * The login data is posted with every secret stripped -- there is no password
   * in this flow by definition, and `stripLoginSecrets` guarantees one cannot
   * leak in from a caller that built the body carelessly.
   */
  async verifyOtp(input: {
    loginData: Record<string, unknown>;
    code: string;
    /** See `uniqueId` on `headers()` below. */
    uniqueId?: string | null;
  }): Promise<MashovLoginResponseView> {
    const response = await this.http.post<MashovLoginPayload>(
      '/api/user/otp',
      { ...stripLoginSecrets(input.loginData), code: stripWhitespace(input.code) },
      { headers: this.headers({}, input.uniqueId) },
    );
    return { data: response.data, ...readLoginHeaders(response.headers) };
  }

  /**
   * `uniqueId` is Mashov's `uniquId` session cookie, stored per connection.
   *
   * A real browser sends it on every same-origin request, so Mashov's own
   * Angular client sends it on all of these routes unconditionally — a server
   * that broke on receiving it would break its own client. We were sending it
   * on `POST /api/login` only (`mashov-credential-validator.service.ts:150`),
   * while three other flows read `mashovUniqueId` out of the database,
   * documented why it mattered, and dropped it. `HouseholdConnection` is
   * uniquely keyed `[schoolCode, username]`, so the value always belongs to
   * the same Mashov account we are calling about.
   *
   * **`verifyMfa` deliberately does NOT pass it, and that is not an
   * oversight.** When `/api/login` answers `403 Reason: MfaRequired`, axios
   * throws, so `readLoginHeaders` never runs and the `Set-Cookie: uniquId` on
   * that 403 is discarded. The value we hold is therefore an OLDER session's
   * cookie, not the one Mashov minted for this challenge — and if Mashov binds
   * a challenge to its session cookie, sending a stale one is strictly worse
   * than sending none. The right fix is to capture the cookie off the
   * triggering 403 and send that back; it needs the wire capture to confirm,
   * and it is a different change from this one.
   */
  private headers(
    extra: Record<string, string> = {},
    uniqueId?: string | null,
  ): Record<string, string> {
    return {
      'X-Csrf-Token': MASHOV_CSRF_TOKEN,
      'Content-Type': 'application/json',
      Referer: `${this.baseUrl}/students/login`,
      ...(uniqueId ? { Cookie: `uniquId=${uniqueId}` } : {}),
      ...extra,
    };
  }
}

export type MfaMethod = 'email' | 'sms';

export interface RequestRecoveryInput {
  semel: number;
  idNumber: string;
  email?: boolean;
  cellphone?: boolean;
}

export interface RequestRecoveryResult {
  /** True when Mashov sent codes on both channels and needs both back. */
  isResettingAndVerifying?: boolean;
}

export interface ResetResult {
  username?: string;
}

export interface VerifyMfaInput {
  /** A login body, built by `buildLoginBody`. Secrets are stripped here. */
  loginData: Record<string, unknown>;
  challengeId: string;
  code: string;
  rememberBrowser: boolean;
}

export interface MashovLoginResponseView {
  data: MashovLoginPayload;
  newUniqueId: string | undefined;
  csrfToken: string | undefined;
  devicePass: string | undefined;
}

/**
 * Parents paste codes with spaces in them, and Mashov's own client strips
 * whitespace before using one. A code rejected for a space the parent cannot
 * see is unrecoverable, because the code is single-use.
 */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Whitespace-stripped and percent-encoded, never spliced into a path raw. */
function pathSegment(value: string): string {
  return encodeURIComponent(stripWhitespace(value));
}

/**
 * The fields `POST /api/login/mfa/verify` rejects.
 *
 * Written as a filter rather than destructuring-with-rest so the list is one
 * named constant that a reader can check against Mashov's own client, instead
 * of four discarded bindings.
 */
const MFA_VERIFY_FORBIDDEN_FIELDS = [
  'password',
  'newPassword',
  'captcha',
  'mfaChallengeId',
] as const;

function stripLoginSecrets(loginData: Record<string, unknown>): Record<string, unknown> {
  const forbidden = new Set<string>(MFA_VERIFY_FORBIDDEN_FIELDS);
  return Object.fromEntries(
    Object.entries(loginData).filter(([key]) => !forbidden.has(key)),
  );
}
