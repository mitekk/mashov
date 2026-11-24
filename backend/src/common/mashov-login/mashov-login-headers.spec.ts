import {
  readLoginHeaders,
  readResponseHeader,
  readUniqueIdCookie,
} from './mashov-login-headers';

/**
 * The parser of every piece of session material Mashov hands back, and until
 * now the only file in `mashov-login/` with no spec.
 *
 * Its own docblock names the failure it exists to prevent: a case-sensitive
 * read of `devicePass` "would silently return `undefined` and quietly disable
 * the trusted-device path — which fails as 'MFA accounts stopped syncing' a
 * day later rather than as an error anyone can see." That is a claim about
 * behaviour, and nothing was checking it.
 *
 * It matters more now that four flows send the `uniquId` cookie this file
 * reads, rather than one.
 */
describe('readResponseHeader', () => {
  it('finds a header whatever case the server chose', () => {
    // The whole reason this function exists. Axios lowercases header names on
    // the Node adapter but not everywhere, and Mashov's own bundle spells it
    // `devicePass`.
    for (const name of ['devicePass', 'DEVICEPASS', 'devicepass', 'DevicePass']) {
      expect(readResponseHeader({ [name]: 'dp-1' }, 'devicepass')).toBe('dp-1');
    }
  });

  it('takes the first value when the header repeats', () => {
    expect(readResponseHeader({ devicepass: ['dp-1', 'dp-2'] }, 'devicepass')).toBe('dp-1');
  });

  it('treats an empty string as absent, not as a credential', () => {
    // A `devicePass: ''` accepted as real would be stored and then used for a
    // trusted-device re-login that cannot work.
    expect(readResponseHeader({ devicepass: '' }, 'devicepass')).toBeUndefined();
  });

  it('ignores a non-string value rather than coercing it', () => {
    expect(readResponseHeader({ devicepass: 42 }, 'devicepass')).toBeUndefined();
    expect(readResponseHeader({ devicepass: [42] }, 'devicepass')).toBeUndefined();
    expect(readResponseHeader({ devicepass: null }, 'devicepass')).toBeUndefined();
  });

  it('survives absent headers', () => {
    expect(readResponseHeader(undefined, 'devicepass')).toBeUndefined();
    expect(readResponseHeader({}, 'devicepass')).toBeUndefined();
  });
});

describe('readUniqueIdCookie', () => {
  it('reads uniquId out of a Set-Cookie string', () => {
    // Note the spelling: Mashov's cookie is `uniquId`, not `uniqueId`. Our
    // own field is `uniqueId`, and conflating the two is how the cookie ends
    // up never sent.
    expect(readUniqueIdCookie('uniquId=abc123; Path=/; HttpOnly')).toBe('abc123');
  });

  it('picks uniquId out of several cookies', () => {
    expect(
      readUniqueIdCookie(['other=1; Path=/', 'uniquId=abc123; Secure', 'more=2']),
    ).toBe('abc123');
  });

  it('does not match a cookie that merely ends in uniquId', () => {
    // `notuniquId=` must not be read as `uniquId=`, or we would store another
    // cookie's value as the session and send it back as one.
    expect(readUniqueIdCookie('notuniquId=wrong; Path=/')).toBeUndefined();
  });

  it('is not fooled by uniquId appearing in another cookie’s value', () => {
    expect(readUniqueIdCookie('other=uniquId=decoy; Path=/')).toBeUndefined();
  });

  it('tolerates whitespace around the name and value', () => {
    expect(readUniqueIdCookie(' uniquId = abc123 ; Path=/')).toBe('abc123');
  });

  it('returns an empty value as empty rather than throwing', () => {
    expect(readUniqueIdCookie('uniquId=; Path=/')).toBe('');
  });

  it('survives absent or malformed input', () => {
    expect(readUniqueIdCookie(undefined)).toBeUndefined();
    expect(readUniqueIdCookie('')).toBeUndefined();
    expect(readUniqueIdCookie('nonsense')).toBeUndefined();
    expect(readUniqueIdCookie([])).toBeUndefined();
  });
});

describe('readLoginHeaders', () => {
  it('reads all three from one response', () => {
    expect(
      readLoginHeaders({
        'set-cookie': ['uniquId=uid-9; Path=/'],
        'x-csrf-token': 'csrf-9',
        devicePass: 'dp-9',
      }),
    ).toEqual({ newUniqueId: 'uid-9', csrfToken: 'csrf-9', devicePass: 'dp-9' });
  });

  it('reports each field independently absent', () => {
    // A response that sets only a cookie is normal; it must not drag the other
    // two into some non-undefined shape.
    expect(readLoginHeaders({ 'set-cookie': 'uniquId=uid-9' })).toEqual({
      newUniqueId: 'uid-9',
      csrfToken: undefined,
      devicePass: undefined,
    });
  });

  it('answers with all three absent for a header-less response', () => {
    expect(readLoginHeaders(undefined)).toEqual({
      newUniqueId: undefined,
      csrfToken: undefined,
      devicePass: undefined,
    });
  });

  it('reads devicePass in the mixed case Mashov actually sends', () => {
    // The single assumption MFA support rests on, per
    // `apis/post-api-loginDevice.md`. If this read fails, MFA sign-in works
    // once and every later cron re-login falls back to a password the account
    // may no longer have.
    expect(readLoginHeaders({ devicePass: 'dp-9' }).devicePass).toBe('dp-9');
  });
});
