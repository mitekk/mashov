import { ApiError, apiFetch } from './client';
import type {
  AppUser,
  School,
  LoginRequest,
  LoginResponse,
  StartRecoveryRequest,
  StartRecoveryResponse,
  CompleteRecoveryRequest,
  CompleteRecoveryResponse,
  SendMfaCodeRequest,
  CreateMfaSessionRequest,
  CreateMfaSessionResponse,
  SetCredentialsRequest,
  SetCredentialsResponse,
} from '@/types/api';

export function getSchools(): Promise<School[]> {
  return apiFetch<School[]>('/auth/schools');
}

export function login(body: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function signOut(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/auth/session', { method: 'DELETE' });
}

// Same reason as `fetchProfile`'s `children`: a backend without the field
// yet must render a header with no count, not `undefined ילדים`.
function normalizeUser(response: AppUser): AppUser {
  return {
    ...response,
    childrenCount: typeof response.childrenCount === 'number' ? response.childrenCount : 0,
  };
}

export async function getMe(): Promise<AppUser> {
  return normalizeUser(await apiFetch<AppUser>('/auth/me'));
}

/**
 * 200 -> the signed-in user, 401 -> null. Never bounces the browser; see
 * `treat401AsAnswer`. Used only by the sign-in page, which has to be able to
 * ask "is there already a session?" from a page the global 401 handler
 * redirects TO.
 *
 * The 4s budget is deliberately far below the proxy's own 15s
 * (`PROXY_TIMEOUT_MS`): a parent on a bad connection must get the form, not
 * stare at a spinner for fifteen seconds. A timeout is treated as "no
 * session", which costs them nothing but one wasted bounce.
 */
export async function getMeOrNull(): Promise<AppUser | null> {
  try {
    return normalizeUser(
      await apiFetch<AppUser>('/auth/me', {
        treat401AsAnswer: true,
        signal: AbortSignal.timeout(4000),
      }),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

// ─── In-app Mashov auth: recovery, MFA ─────────────────────────────────────

/**
 * Step 1 of password recovery.
 *
 * Answers 202 whether or not the account exists, by design: the endpoint must
 * not be usable to test whether an ID number is registered at a school.
 */
export function startRecovery(
  body: StartRecoveryRequest,
): Promise<StartRecoveryResponse> {
  return apiFetch<StartRecoveryResponse>('/auth/credential-recoveries', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Step 2: set the new password with the code (or codes) Mashov sent. */
export function completeRecovery(
  recoveryId: string,
  body: CompleteRecoveryRequest,
): Promise<CompleteRecoveryResponse> {
  return apiFetch<CompleteRecoveryResponse>(
    `/auth/credential-recoveries/${encodeURIComponent(recoveryId)}/password`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Ask Mashov to (re)send the code for an open MFA challenge. */
export function sendMfaCode(
  challengeId: string,
  body: SendMfaCodeRequest,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/auth/mfa-challenges/${encodeURIComponent(challengeId)}/code`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Answer the challenge and sign in. Sets the `mashov_session` cookie. */
export function createMfaSession(
  challengeId: string,
  body: CreateMfaSessionRequest,
): Promise<CreateMfaSessionResponse> {
  return apiFetch<CreateMfaSessionResponse>(
    `/auth/mfa-challenges/${encodeURIComponent(challengeId)}/session`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

// ─── In-app Mashov auth: MFA, recovery, forced credential change ───────────

/**
 * Satisfy Mashov's forced credential change and sign in.
 *
 * Driven by `PASSWORD_CHANGE_REQUIRED` / `CREDENTIALS_SETUP_REQUIRED` from
 * `POST /auth/login`, where the password is correct and Mashov still refuses.
 */
export function setCredentials(
  body: SetCredentialsRequest,
): Promise<SetCredentialsResponse> {
  return apiFetch<SetCredentialsResponse>('/auth/credentials', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Step 1 of passwordless sign-in.
 *
 * Answers `409 PASSWORD_SIGN_IN_REQUIRED` for a school that has never been
 * signed into with a password, BEFORE sending a code -- so the parent is never
 * left holding a code they cannot use.
 */

/** Step 2 of passwordless sign-in. Sets the `mashov_session` cookie. */
