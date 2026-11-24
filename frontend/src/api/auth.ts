import { apiFetch } from './client';
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
  RequestOtpRequest,
  RequestOtpResponse,
  CreateOtpSessionRequest,
  CreateOtpSessionResponse,
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

export async function getMe(): Promise<AppUser> {
  const response = await apiFetch<AppUser>('/auth/me');
  // Same reason as `fetchProfile`'s `children`: a backend without the field
  // yet must render a header with no count, not `undefined ילדים`.
  return {
    ...response,
    childrenCount: typeof response.childrenCount === 'number' ? response.childrenCount : 0,
  };
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

// ─── In-app Mashov auth: forced credential change, passwordless OTP ────────

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
// NOTE: gated off. `PASSWORDLESS_SIGN_IN_ENABLED` in `@/lib/featureFlags` is
// `false`, so nothing below reaches a parent today -- the upstream contract was
// never observed and Mashov refuses step 1. Kept, not deleted, because the
// backend routes are live and a capture may make it work. See ADR-0042 §11.
export function requestOtp(body: RequestOtpRequest): Promise<RequestOtpResponse> {
  return apiFetch<RequestOtpResponse>('/auth/otp-requests', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Step 2 of passwordless sign-in. Sets the `mashov_session` cookie. */
// NOTE: gated off. `PASSWORDLESS_SIGN_IN_ENABLED` in `@/lib/featureFlags` is
// `false`, so nothing below reaches a parent today -- the upstream contract was
// never observed and Mashov refuses step 1. Kept, not deleted, because the
// backend routes are live and a capture may make it work. See ADR-0042 §11.
export function createOtpSession(
  otpRequestId: string,
  body: CreateOtpSessionRequest,
): Promise<CreateOtpSessionResponse> {
  return apiFetch<CreateOtpSessionResponse>(
    `/auth/otp-requests/${encodeURIComponent(otpRequestId)}/session`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
