import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import {
  createMashovAxios,
  resolveMashovBaseUrl,
} from '../http/mashov-http';
import { MASHOV_CSRF_TOKEN } from './mashov-login-body';
import { readCookie, readLoginHeaders } from './mashov-login-headers';
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

    const response = await this.http.post<RecoveryBody>(
      '/api/user/recover',
      body,
      { headers: this.headers() },
    );

    // The `NonceRef` cookie is minted HERE and nowhere else. Step 2 is refused
    // without it, and it never appears in a response body -- so a caller that
    // reads only `response.data` cannot complete the reset it just started.
    return {
      body: response.data ?? {},
      nonceRef: readCookie(
        (response.headers as Record<string, unknown> | undefined)?.[
          'set-cookie'
        ] as string | string[] | undefined,
        NONCE_COOKIE_NAME,
      ),
    };
  }

  /**
   * Step 2, single channel. `404` from here means a bad code — but only
   * because the caller already enforced the password policy, since Mashov
   * answers 404 for a policy violation too.
   *
   * **Deliberately cookie-less.** The 2026-11-24 capture records no `Cookie`
   * header on this route: it is genuinely unauthenticated and the single-use
   * code is the whole authorisation. So the `uniquId` gap documented on
   * `headers()` below does NOT apply here, and this is not an instance of it —
   * sending a session cookie would assert a session this call does not have.
   * Nothing to re-open.
   *
   * `response.data ?? {}` is load-bearing: the capture returned an EMPTY body
   * on success, so there is no field to read. The caller decides success from
   * the status code — axios throws on a non-2xx, so reaching here IS the 2xx.
   */
  async resetPassword(
    code: string,
    newPassword: string,
    nonceRef?: string,
  ): Promise<ResetResult> {
    const response = await this.http.post<ResetResult>(
      `/api/user/reset/${pathSegment(code)}`,
      { newPassword },
      {
        headers: this.headers(
          nonceCookie(nonceRef),
          undefined,
          RESET_REFERER_PATH,
        ),
      },
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
    nonceRef?: string,
  ): Promise<ResetResult> {
    const first = pathSegment(code);
    const second = secondCode ? pathSegment(secondCode) : '';
    const path = second
      ? `/api/user/reset/verify/${first}/${second}`
      : `/api/user/reset/verify/${first}`;

    const response = await this.http.post<ResetResult>(
      path,
      { newPassword },
      {
        headers: this.headers(
          nonceCookie(nonceRef),
          undefined,
          RESET_REFERER_PATH,
        ),
      },
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
    refererPath: string = LOGIN_REFERER_PATH,
  ): Record<string, string> {
    return {
      'X-Csrf-Token': MASHOV_CSRF_TOKEN,
      'Content-Type': 'application/json',
      Referer: `${this.baseUrl}${refererPath}`,
      ...(uniqueId ? { Cookie: `uniquId=${uniqueId}` } : {}),
      ...extra,
    };
  }
}

/**
 * The `Referer` is per-route, because the parent is on a different page.
 *
 * Both are the page Mashov's own client was observed to send from, and they are
 * named constants so a reader can check them against the captures in `apis/`:
 * `/students/login` for login, MFA, trusted-device and the authenticated
 * change routes (and for recovery step 1, submitted from the login page's
 * forgot-password form), `/students/reset` for the two step-2 reset routes —
 * `apis/post-api-user-reset-token.md`, captured 2026-11-24.
 *
 * Mashov has not been observed to reject a mismatched `Referer` on these
 * routes, so this is not by itself the cause of a refusal; send the page the
 * parent is actually on regardless.
 */
/**
 * The cookie Mashov binds a recovery to.
 *
 * Minted by `POST /api/user/recover`, required by both reset routes. Without
 * it Mashov answers `400 application/problem+json` with no `Reason` header --
 * a request-validation refusal, before the code is ever examined. Captured in
 * a clean incognito session on 2026-11-25 and proven by replay: the same three
 * headers we already send, plus this cookie, change the password.
 *
 * Deliberately NOT `uniquId`. That is a login session cookie, and this route
 * neither sets nor wants one.
 */
const NONCE_COOKIE_NAME = 'NonceRef';

/**
 * The `Cookie` header for a reset, or no header at all.
 *
 * Never `NonceRef=undefined`: a header asserting a nonce we do not hold cannot
 * be told apart upstream from a forged one, and reads as a malformed request
 * rather than as the missing session it actually is.
 */
function nonceCookie(nonceRef: string | undefined): Record<string, string> {
  return nonceRef ? { Cookie: `${NONCE_COOKIE_NAME}=${nonceRef}` } : {};
}

const LOGIN_REFERER_PATH = '/students/login';
const RESET_REFERER_PATH = '/students/reset';

export type MfaMethod = 'email' | 'sms';

export interface RequestRecoveryInput {
  semel: number;
  idNumber: string;
  /**
   * The destination, and the channel.
   *
   * Captured from Mashov's own client, 2026-11-24. Exactly ONE of these is
   * sent, and its NAME is how Mashov learns which channel to use -- there is
   * no separate flag. The value is the address itself:
   *
   *   {"email":"parent@example.com","idNumber":"...","semel":482273}
   *   {"cellphone":"0501234567",    "idNumber":"...","semel":482273}
   *
   * We previously sent `email: true` / `cellphone: true`, guessing a boolean
   * flag. `true` will not bind to a .NET string property, so Mashov answered
   * 400 and nothing was ever sent -- reported as "no email arrives on recovery
   * nor sms". `apis/post-api-user-recover.md` had flagged this exact field as
   * the one thing a live call still had to confirm.
   *
   * The parent types the address, and Mashov checks it against what the school
   * holds. It does NOT send to a contact it already has.
   */
  email?: string;
  cellphone?: string;
}

/** What Mashov's own `POST /api/user/recover` body carries. */
export interface RecoveryBody {
  /** True when Mashov sent codes on both channels and needs both back. */
  isResettingAndVerifying?: boolean;
}

export interface RequestRecoveryResult {
  /**
   * Mashov's response body, verbatim and on its own.
   *
   * Kept separate from `nonceRef` on purpose. The caller logs
   * `Object.keys(body)` as the fingerprint of a 200 that sent no code at all,
   * so a field WE synthesise must never be able to appear in it -- that would
   * quietly disable the only signal that failure has.
   */
  body: RecoveryBody;
  /**
   * The `NonceRef` cookie Mashov minted for this recovery, if it set one.
   *
   * Step 2 MUST send it back. It lives about ten minutes and is not refreshed,
   * so it is the real deadline on a reset -- shorter than our own handle's.
   */
  nonceRef: string | undefined;
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
