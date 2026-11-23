import axios from 'axios';

/**
 * Mashov's `Reason` response header, and what each value means for us.
 *
 * Mashov answers a failed `POST /api/login` with an HTTP status plus a `Reason`
 * header naming the actual cause. We threw all of them away and told every
 * caller "wrong password". For seven of these values the password is *correct*
 * and the account needs a next step — an MFA code, a forced password change, a
 * captcha — so the parent retypes a password that was right until the rate
 * limiter locks them out. That is the worst dead end in the product, and this
 * module is what converts it.
 *
 * The classifier is deliberately split per surface (login here, recovery, MFA
 * and credential-change in their own modules): the same Reason means different
 * things depending on what was asked. `UserSuspended` is a captcha prompt on
 * sign-in and an enumeration oracle on recovery step 1, where it must be
 * swallowed instead.
 */

/**
 * Every Reason read out of `https://web.mashov.info/students/main-*.js`.
 *
 * 32 values. The design note that introduced this said "33" in prose while
 * listing 32; the list is what was actually read off the bundle, so the list
 * wins. A value arriving that is not in here classifies as
 * `INVALID_CREDENTIALS` rather than being guessed at.
 */
export const MASHOV_REASONS = [
  'BindExists',
  'BindNotFound',
  'CellphoneLocked',
  'ChangePass',
  'CreateUsername',
  'EmailLimitExceeded',
  'EmailLocked',
  'IdNumberNoMatch',
  'InvalidSchool',
  'LoginMethodBlocked',
  'MfaCodeExpired',
  'MfaContactMissing',
  'MfaExpired',
  'MfaInvalidCode',
  'MfaLocked',
  'MfaRequired',
  'MfaResendTooSoon',
  'NoChildren',
  'NoParentsAccess',
  'NotAuthenticated',
  'NotContactInSchool',
  'PrivilegeEscalation',
  'SameSchool',
  'SchoolClosed',
  'SetUsernameAndPass',
  'UserInactive',
  'UserInactiveInYear',
  'UsernameExists',
  'UsernameLocked',
  'UserSuspended',
  'UseUsername',
  'UserExists',
] as const;

export type MashovReason = (typeof MASHOV_REASONS)[number];

const REASON_SET = new Set<string>(MASHOV_REASONS);

/** Our side of the wire: the envelope fields a classified failure produces. */
export interface ClassifiedReason {
  code: string;
  /** HTTP status. Never 401 for a signposted reason — see below. */
  status: number;
  message: string;
}

/**
 * Today's answer, and the fallback for every Reason with no signpost of its
 * own. 401 is correct here and nowhere else in this surface: `apiFetch` in the
 * frontend tolerates a 401 whose code is `INVALID_CREDENTIALS` and
 * hard-redirects to `/auth/sign-in` on every other 401. A signposted failure
 * answered 401 would throw the parent off the very page carrying the
 * instructions they need, so all of those are 400.
 */
export const INVALID_CREDENTIALS: ClassifiedReason = {
  code: 'INVALID_CREDENTIALS',
  status: 401,
  message: 'Invalid credentials, please try again',
};

/** An upstream that never answered. Shared by every surface in this module. */
export const UPSTREAM_ERROR: ClassifiedReason = {
  code: 'UPSTREAM_ERROR',
  status: 502,
  message: 'Mashov is not reachable right now. Please try again shortly.',
};

/**
 * Reason → envelope, for `POST /api/login`.
 *
 * User-visible Hebrew lives in the frontend's code→copy map, not here: these
 * messages are English like every other envelope the backend emits, and they
 * are a fallback for a client that does not know the code rather than the copy
 * a parent reads.
 */
const LOGIN_CLASSIFICATION: Partial<Record<MashovReason, ClassifiedReason>> = {
  MfaRequired: {
    code: 'MFA_REQUIRED',
    status: 400,
    message: 'Mashov requires a one-time code to finish signing in',
  },
  ChangePass: {
    code: 'PASSWORD_CHANGE_REQUIRED',
    status: 400,
    message: 'Mashov requires a password change before signing in',
  },
  SetUsernameAndPass: {
    code: 'CREDENTIALS_SETUP_REQUIRED',
    status: 400,
    message: 'Mashov requires a username and password to be set up first',
  },
  CreateUsername: {
    code: 'CREDENTIALS_SETUP_REQUIRED',
    status: 400,
    message: 'Mashov requires a username and password to be set up first',
  },
  // Mashov escalates to a Cloudflare Turnstile challenge after repeated
  // failures. A server-side axios call cannot solve one, so the only honest
  // answer is to ask the browser for a token.
  UserSuspended: {
    code: 'CAPTCHA_REQUIRED',
    status: 400,
    message: 'Mashov is asking for a captcha before this account can sign in',
  },
  NoChildren: {
    code: 'NO_CHILDREN',
    status: 400,
    message: 'No children are associated with this Mashov account',
  },
  NoParentsAccess: {
    code: 'NO_CHILDREN',
    status: 400,
    message: 'No children are associated with this Mashov account',
  },
  SchoolClosed: {
    code: 'SCHOOL_CLOSED',
    status: 400,
    message: 'This school is closed in Mashov',
  },
  UserInactive: {
    code: 'USER_INACTIVE',
    status: 400,
    message: 'This account is not active for the current school year',
  },
  UserInactiveInYear: {
    code: 'USER_INACTIVE',
    status: 400,
    message: 'This account is not active for the current school year',
  },
  UseUsername: {
    code: 'USE_USERNAME',
    status: 400,
    message: 'Sign in with the Mashov username rather than the ID number',
  },
};

/** What a failed sign-in should answer, given the Reason Mashov sent. */
export function classifyLoginReason(reason: MashovReason | undefined): ClassifiedReason {
  if (!reason) return INVALID_CREDENTIALS;
  return LOGIN_CLASSIFICATION[reason] ?? INVALID_CREDENTIALS;
}

/**
 * The `Reason` header off an upstream error, if it carries a known one.
 *
 * Case-insensitive because axios lowercases header names on the Node adapter
 * and not on every other path, and an unknown value returns `undefined` rather
 * than being passed through: a Reason we have never seen must fall back to
 * today's behaviour, not become a code no caller handles.
 */
export function readReason(error: unknown): MashovReason | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const headers = error.response?.headers as Record<string, unknown> | undefined;
  if (!headers) return undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'reason') continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (REASON_SET.has(trimmed)) return trimmed as MashovReason;
  }
  return undefined;
}

/**
 * The MFA challenge id off an upstream error body.
 *
 * Without it a `MFA_REQUIRED` is a dead end just like the "wrong password" it
 * replaces: the challenge id is the only handle on the challenge Mashov just
 * opened. Both spellings are accepted because the bundle uses `challengeId` in
 * the response and `mfaChallengeId` in the request it echoes back into.
 */
export function readChallengeId(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const candidate = record.challengeId ?? record.mfaChallengeId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}
