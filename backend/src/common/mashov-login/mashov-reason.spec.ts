import { AxiosError } from 'axios';
import {
  MASHOV_REASONS,
  type MashovReason,
  classifyLoginReason,
  isMashovRejection,
  readChallengeId,
  readReason,
} from './mashov-reason';

/**
 * Every Reason Mashov can send, and what sign-in turns it into.
 *
 * The table is exhaustive on purpose, and a compile-time `Record<MashovReason,
 * ...>` rather than a loose object: a Reason added to the union without a row
 * here fails the build instead of silently falling through to "wrong
 * password", which is the exact failure this whole surface exists to fix.
 */
const EXPECTED: Record<MashovReason, { code: string; status: number }> = {
  // Signposted — the user is on a correct password and needs a next step.
  MfaRequired: { code: 'MFA_REQUIRED', status: 400 },
  ChangePass: { code: 'PASSWORD_CHANGE_REQUIRED', status: 400 },
  SetUsernameAndPass: { code: 'CREDENTIALS_SETUP_REQUIRED', status: 400 },
  CreateUsername: { code: 'CREDENTIALS_SETUP_REQUIRED', status: 400 },
  // 422, not 400, and the same on all four surfaces. The request was
  // understood; it cannot be processed until a challenge is satisfied, which is
  // what Unprocessable Entity means. The constraint that matters -- never 401 --
  // holds either way.
  UserSuspended: { code: 'CAPTCHA_REQUIRED', status: 422 },
  NoChildren: { code: 'NO_CHILDREN', status: 400 },
  NoParentsAccess: { code: 'NO_CHILDREN', status: 400 },
  SchoolClosed: { code: 'SCHOOL_CLOSED', status: 400 },
  UserInactive: { code: 'USER_INACTIVE', status: 400 },
  UserInactiveInYear: { code: 'USER_INACTIVE', status: 400 },
  UseUsername: { code: 'USE_USERNAME', status: 400 },

  // Everything else keeps today's answer. 401 is deliberate and load-bearing:
  // `frontend/src/api/client.ts` tolerates a 401 whose code is
  // INVALID_CREDENTIALS and hard-redirects on every other 401.
  BindExists: { code: 'INVALID_CREDENTIALS', status: 401 },
  BindNotFound: { code: 'INVALID_CREDENTIALS', status: 401 },
  CellphoneLocked: { code: 'INVALID_CREDENTIALS', status: 401 },
  EmailLimitExceeded: { code: 'INVALID_CREDENTIALS', status: 401 },
  EmailLocked: { code: 'INVALID_CREDENTIALS', status: 401 },
  IdNumberNoMatch: { code: 'INVALID_CREDENTIALS', status: 401 },
  InvalidSchool: { code: 'INVALID_CREDENTIALS', status: 401 },
  LoginMethodBlocked: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaCodeExpired: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaContactMissing: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaExpired: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaInvalidCode: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaLocked: { code: 'INVALID_CREDENTIALS', status: 401 },
  MfaResendTooSoon: { code: 'INVALID_CREDENTIALS', status: 401 },
  NotAuthenticated: { code: 'INVALID_CREDENTIALS', status: 401 },
  NotContactInSchool: { code: 'INVALID_CREDENTIALS', status: 401 },
  PrivilegeEscalation: { code: 'INVALID_CREDENTIALS', status: 401 },
  SameSchool: { code: 'INVALID_CREDENTIALS', status: 401 },
  UsernameExists: { code: 'INVALID_CREDENTIALS', status: 401 },
  UsernameLocked: { code: 'INVALID_CREDENTIALS', status: 401 },
  UserExists: { code: 'INVALID_CREDENTIALS', status: 401 },
};

function reasonError(reason: string, headerName = 'reason', status = 403): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    data: {},
    headers: { [headerName]: reason },
  } as unknown as AxiosError['response'];
  return err;
}

describe('MASHOV_REASONS', () => {
  it('covers every Reason read out of the Angular bundle', () => {
    // 32, not the 33 the plan's prose claims: the prose and its own list
    // disagree, and the list is the thing that was actually read off the wire.
    expect(MASHOV_REASONS).toHaveLength(32);
    expect(new Set(MASHOV_REASONS).size).toBe(MASHOV_REASONS.length);
  });
});

describe('classifyLoginReason', () => {
  for (const reason of Object.keys(EXPECTED) as MashovReason[]) {
    const expected = EXPECTED[reason];
    it(`maps ${reason} to ${expected.code} (${expected.status})`, () => {
      const classified = classifyLoginReason(reason);
      expect(classified.code).toBe(expected.code);
      expect(classified.status).toBe(expected.status);
      expect(classified.message.length).toBeGreaterThan(0);
    });
  }

  it('maps a Reason-less failure to INVALID_CREDENTIALS, exactly as before', () => {
    expect(classifyLoginReason(undefined)).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
  });

  it('never answers 401 for a signposted reason', () => {
    // A 401 would send `apiFetch` into its hard redirect and bounce the parent
    // off the page carrying the instructions they need.
    const signposted = (Object.keys(EXPECTED) as MashovReason[]).filter(
      (reason) => EXPECTED[reason].code !== 'INVALID_CREDENTIALS',
    );
    expect(signposted.length).toBeGreaterThan(0);
    for (const reason of signposted) {
      expect(classifyLoginReason(reason).status).not.toBe(401);
    }
  });
});

describe('readReason', () => {
  it('reads the Reason response header', () => {
    expect(readReason(reasonError('ChangePass'))).toBe('ChangePass');
  });

  it('reads the header whatever case the transport used', () => {
    expect(readReason(reasonError('MfaRequired', 'Reason'))).toBe('MfaRequired');
    expect(readReason(reasonError('MfaRequired', 'REASON'))).toBe('MfaRequired');
  });

  it('trims surrounding whitespace', () => {
    expect(readReason(reasonError('  UserSuspended  '))).toBe('UserSuspended');
  });

  it('returns undefined for a Reason it does not recognise', () => {
    // A value we have never seen must not be guessed at. Falling through to
    // INVALID_CREDENTIALS is today's behaviour and the safe default.
    expect(readReason(reasonError('SomethingNewUpstream'))).toBeUndefined();
  });

  it('returns undefined when the response carries no Reason header', () => {
    const err = new AxiosError('Request failed');
    err.response = { status: 403, data: {}, headers: {} } as unknown as AxiosError['response'];
    expect(readReason(err)).toBeUndefined();
  });

  it('returns undefined for a non-axios error', () => {
    expect(readReason(new Error('boom'))).toBeUndefined();
    expect(readReason(undefined)).toBeUndefined();
    expect(readReason(null)).toBeUndefined();
  });
});

describe('readChallengeId', () => {
  function withBody(data: unknown): AxiosError {
    const err = new AxiosError('Request failed');
    err.response = {
      status: 403,
      data,
      headers: { reason: 'MfaRequired' },
    } as unknown as AxiosError['response'];
    return err;
  }

  it('reads challengeId from the response body', () => {
    expect(readChallengeId(withBody({ challengeId: 'ch-1' }))).toBe('ch-1');
  });

  it('accepts the mfaChallengeId spelling too', () => {
    expect(readChallengeId(withBody({ mfaChallengeId: 'ch-2' }))).toBe('ch-2');
  });

  it('returns undefined when there is no challenge id to read', () => {
    expect(readChallengeId(withBody({}))).toBeUndefined();
    expect(readChallengeId(withBody('a string body'))).toBeUndefined();
    expect(readChallengeId(new Error('boom'))).toBeUndefined();
  });

  it('ignores a non-string challenge id rather than coercing it', () => {
    expect(readChallengeId(withBody({ challengeId: 42 }))).toBeUndefined();
  });
});

/**
 * A 4xx is only evidence about the user's input if it came from Mashov's API.
 *
 * The egress proxy answers `403` with an HTML body and no `Reason` header when
 * its ACL rejects us -- which is a thing that happens, and is recorded as
 * happening on a dev machine. Blaming that on the recovery code tells a parent
 * their code was wrong after they have already burned it, which is
 * unrecoverable.
 */
describe('isMashovRejection', () => {
  function response(headers: Record<string, string>, status = 403): AxiosError {
    const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
    err.response = {
      status,
      data: {},
      headers,
    } as unknown as AxiosError['response'];
    return err;
  }

  it('accepts a response carrying a known Reason header', () => {
    expect(isMashovRejection(response({ reason: 'MfaInvalidCode' }))).toBe(true);
  });

  it('accepts a JSON response, which is what the API answers with', () => {
    expect(
      isMashovRejection(response({ 'content-type': 'application/json; charset=utf-8' })),
    ).toBe(true);
  });

  it('rejects an HTML error page, which is what a proxy ACL answers with', () => {
    expect(isMashovRejection(response({ 'content-type': 'text/html' }))).toBe(false);
  });

  it('rejects a response with no content type and no Reason at all', () => {
    expect(isMashovRejection(response({}))).toBe(false);
  });

  it('accepts an unknown Reason value, which still proves it reached the API', () => {
    // `readReason` returns undefined for a value it does not recognise, but the
    // header's presence is what matters here.
    expect(isMashovRejection(response({ Reason: 'SomeBrandNewReason' }))).toBe(true);
  });

  it('is false for a non-axios error and for a response-less one', () => {
    expect(isMashovRejection(new Error('boom'))).toBe(false);
    expect(isMashovRejection(new AxiosError('no response'))).toBe(false);
  });
});
