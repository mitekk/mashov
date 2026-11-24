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
  //
  // 422, not 400, and the same on all four surfaces that can emit this code.
  // The request was understood; it cannot be processed until a challenge is
  // satisfied, which is what Unprocessable Entity means. One code answering two
  // different statuses depending on which route you hit is a trap for the next
  // reader. The constraint that actually matters -- never 401, because
  // `apiFetch` hard-redirects on those -- holds either way.
  UserSuspended: {
    code: 'CAPTCHA_REQUIRED',
    status: 422,
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

/**
 * True when a failed response actually came from Mashov's API.
 *
 * A 4xx is only evidence about what the user typed if Mashov's API produced
 * it. Our egress is a residential proxy, and a proxy ACL rejection answers
 * `403` with an HTML error page and no `Reason` header -- as does a WAF, a
 * captive portal, or anything else between us and them. `isUpstreamUnreachable`
 * cannot catch those: it is true only when there was NO response at all.
 *
 * Blaming one of those on the user's single-use recovery code tells a parent
 * their code was wrong after they have already burned it, and they cannot ask
 * for that code again. So every "that code is not valid" answer is gated on
 * this, and anything else becomes `UPSTREAM_ERROR`.
 *
 * Evidence accepted: a `Reason` header at all (even a value we do not
 * recognise -- its presence proves the API answered), or a JSON content type,
 * which is what the API replies with and what an HTML error page is not.
 */
export function isMashovRejection(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const headers = error.response?.headers as Record<string, unknown> | undefined;
  if (!headers) return false;

  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === 'reason') {
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw === 'string' && raw.trim().length > 0) return true;
    }
    if (name === 'content-type') {
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw === 'string' && raw.toLowerCase().includes('json')) return true;
    }
  }
  return false;
}

/** The one response header this module reads by name, case-insensitively. */
function responseHeader(error: unknown, wanted: string): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const headers = error.response?.headers as Record<string, unknown> | undefined;
  if (!headers) return undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

/**
 * One log line describing an upstream failure we could not map, and the only
 * sanctioned way to log one.
 *
 * ## Why this exists
 *
 * Every classifier in this surface turned an unmapped Mashov 4xx straight into
 * user-facing copy and logged nothing. A passwordless sign-in that Mashov
 * refused therefore reached the parent as "that code is not valid" and left no
 * trace at all of what Mashov actually said — so the failure was not merely
 * mis-reported, it was undiagnosable. This line is what makes one production
 * repro enough.
 *
 * ## The raw header, not `readReason`
 *
 * `readReason` returns `undefined` for any value outside `MASHOV_REASONS`,
 * which is right for classification — a Reason we have never seen must not
 * become a code no caller handles — and useless for diagnosis, because an
 * unrecognised Reason is exactly the evidence worth having. So this reads the
 * header verbatim, and truncates rather than trusting its length.
 *
 * ## It cannot carry a secret, by construction
 *
 * `path` is a **caller-supplied literal**, never `err.config?.url`:
 * `MashovRecoveryService.resetPassword` puts a single-use recovery code *in the
 * path*, so a helper that logged the request URL would write live recovery
 * codes to the logs the first time it was reused on that surface — exactly what
 * ADR-0042 §9 forbids. For the same reason nothing here touches
 * `err.response?.data`, `err.config?.data` or `err.config?.headers` (which
 * carries `Cookie`). Response status and the two response headers below are the
 * whole of what it can see.
 *
 * `semel` is a public school code — the sign-in form fetches the entire list —
 * and is already logged across this surface. It is optional because the MFA
 * resend route genuinely does not have one in scope; it holds a `challengeId`
 * instead, and that is a bearer handle for someone else's challenge, so it is
 * not logged either. `username` is NOT logged and must not be: for these
 * accounts it is the parent's national ID number, which is the thing §9's
 * HMAC'd rate-limit keys exist to keep out of plaintext.
 */
export function describeMashovFailure(
  error: unknown,
  context: { stage: string; semel?: number; path: string },
): string {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const reason = responseHeader(error, 'reason')?.trim().slice(0, 64);
  const contentType = responseHeader(error, 'content-type')?.trim().slice(0, 64);

  // Infrastructure-only headers, and the difference between "Mashov refused
  // this account" and "something between us and Mashov refused the request".
  // An HTML 403 from a proxy ACL is already caught by `isMashovRejection`, but
  // a proxy that answers 403 with a JSON content type is misclassified as a
  // Mashov rejection, and these two headers are what give it away. Neither can
  // carry user data.
  const server = responseHeader(error, 'server')?.trim().slice(0, 64);
  const via = responseHeader(error, 'via')?.trim().slice(0, 64);

  return [
    `stage=${context.stage}`,
    `semel=${context.semel ?? 'none'}`,
    `path=${context.path}`,
    `status=${status ?? 'none'}`,
    `reason=${reason || 'none'}`,
    `contentType=${contentType || 'none'}`,
    `server=${server || 'none'}`,
    `via=${via || 'none'}`,
    `signed=${isMashovRejection(error)}`,
  ].join(' ');
}
