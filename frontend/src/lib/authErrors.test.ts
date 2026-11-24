import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import type { AuthErrorCode } from '@/types/api';
import { AUTH_ERROR_COPY, readAuthError } from './authErrors';

function apiError(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new ApiError(status, 'upstream message', {
    error: { code, message: 'upstream message', details: [], ...extra },
  });
}

/**
 * Every code the backend's Reason classifier can emit needs copy of its own.
 * A code with no copy renders the generic "something went wrong", which is the
 * dead end this whole surface exists to remove -- so the map is exhaustive by
 * type, and a code added to the union without copy fails the build.
 */
describe('AUTH_ERROR_COPY', () => {
  // Every code the whole in-app auth surface can emit, not just sign-in. The
  // list is duplicated here deliberately: `Object.keys` alone would pass
  // whatever the map happens to contain, and the point is to notice when a
  // backend code gains or loses its copy.
  const CODES: AuthErrorCode[] = [
    'INVALID_CREDENTIALS',
    'MFA_REQUIRED',
    'PASSWORD_CHANGE_REQUIRED',
    'CREDENTIALS_SETUP_REQUIRED',
    'CAPTCHA_REQUIRED',
    'NO_CHILDREN',
    'SCHOOL_CLOSED',
    'USER_INACTIVE',
    'USE_USERNAME',
    'UPSTREAM_ERROR',
    'RECOVERY_THROTTLED',
    'RECOVERY_SESSION_EXPIRED',
    'INVALID_RECOVERY_CODE',
    'RECOVERY_CODE_EXPIRED',
    'RECOVERY_LOCKED',
    'SECOND_CODE_REQUIRED',
    'WEAK_PASSWORD',
    'INVALID_MFA_CODE',
    'MFA_CODE_EXPIRED',
    'MFA_LOCKED',
    'MFA_RESEND_TOO_SOON',
    'MFA_CONTACT_MISSING',
    'MFA_SEND_REFUSED',
    'USERNAME_TAKEN',
    'USERNAME_LOCKED',
    'CREDENTIALS_SETUP_FAILED',
    'VALIDATION_ERROR',
    'RATE_LIMITED',
  ];

  it('has Hebrew copy for every auth error code', () => {
    for (const code of CODES) {
      expect(AUTH_ERROR_COPY[code], code).toBeTruthy();
      // Hebrew, not an untranslated backend string leaking to the parent.
      expect(AUTH_ERROR_COPY[code], code).toMatch(/[֐-׿]/);
    }
  });

  it('covers exactly the codes in the union, with nothing extra', () => {
    expect(Object.keys(AUTH_ERROR_COPY).sort()).toEqual([...CODES].sort());
  });

  /**
   * The dead end a parent holding a REAL code can fall into.
   *
   * A step-1 request for an address the school does not hold answers an
   * indistinguishable 202 with a fabricated handle (ADR-0042, deliberately),
   * and step 2 then refuses every code against it while burning the five
   * attempts. The response must stay indistinguishable — that is the
   * anti-enumeration choice and weakening it is not on the table — but once the
   * budget is spent there is nothing left to protect: the parent is starting
   * over regardless, and "start again" alone sends them round the same loop
   * typing the same wrong address.
   *
   * So the lockout copy, and only the lockout copy, names the address as the
   * thing to re-check. It reveals nothing: it is shown to anyone who exhausts
   * five attempts, whatever the cause.
   */
  it('tells a locked-out parent to re-check the address, not just to start again', () => {
    expect(AUTH_ERROR_COPY.RECOVERY_LOCKED).toMatch(/מחדש/);
    // The actionable half: the typo'd address is the one cause no error
    // message is allowed to name directly.
    expect(AUTH_ERROR_COPY.RECOVERY_LOCKED).toMatch(/אימייל|טלפון/);
  });
});

describe('readAuthError', () => {
  it('reads the code out of the error envelope', () => {
    expect(readAuthError(apiError(400, 'SCHOOL_CLOSED')).code).toBe('SCHOOL_CLOSED');
  });

  it('returns that code’s Hebrew copy', () => {
    expect(readAuthError(apiError(400, 'NO_CHILDREN')).message).toBe(
      AUTH_ERROR_COPY.NO_CHILDREN,
    );
  });

  it('carries the MFA challengeId through so the form can route to /auth/mfa', () => {
    const read = readAuthError(apiError(400, 'MFA_REQUIRED', { challengeId: 'ch-9' }));
    expect(read.code).toBe('MFA_REQUIRED');
    expect(read.challengeId).toBe('ch-9');
  });

  it('treats a 429 as a rate limit rather than bad credentials', () => {
    // The parent typed the right password; telling them it was wrong is what
    // sends them round the loop that got them rate limited.
    expect(readAuthError(apiError(429, 'TOO_MANY_REQUESTS')).message).toMatch(
      /[֐-׿]/,
    );
    expect(readAuthError(apiError(429, 'TOO_MANY_REQUESTS')).code).toBe(
      'TOO_MANY_REQUESTS',
    );
  });

  it('falls back to generic copy for a code it does not know', () => {
    const read = readAuthError(apiError(400, 'SOMETHING_NEW'));
    expect(read.code).toBe('SOMETHING_NEW');
    expect(read.message).toMatch(/[֐-׿]/);
  });

  it('falls back to generic copy for an error that is not an ApiError', () => {
    const read = readAuthError(new Error('network down'));
    expect(read.code).toBeUndefined();
    expect(read.message).toMatch(/[֐-׿]/);
  });

  it('never returns an empty message', () => {
    for (const err of [apiError(500, ''), new Error(''), undefined, null]) {
      expect(readAuthError(err).message.length).toBeGreaterThan(0);
    }
  });
});
