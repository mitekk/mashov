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
