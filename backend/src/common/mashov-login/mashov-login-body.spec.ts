import { MASHOV_CSRF_TOKEN, buildLoginBody } from './mashov-login-body';

/**
 * The body this builder emits replaced three hand-written copies
 * (AuthService.postLogin, MashovSessionService x2). The default case is
 * asserted by exact deep equality on purpose: anything added or dropped here
 * changes what every sign-in sends upstream, and "no behaviour change" is the
 * whole contract of the consolidation.
 */
describe('buildLoginBody', () => {
  const base = { semel: 12345, year: 2027, username: 'testuser', password: 'pw' };

  it('emits exactly the fields the three previous copies sent', () => {
    expect(buildLoginBody(base)).toEqual({
      semel: 12345,
      year: 2027,
      username: 'testuser',
      password: 'pw',
      IsBiometric: false,
      appName: 'info.mashov.students',
      apiVersion: '3.20210425',
      appVersion: 3.20210425,
      appBuild: 3.20210425,
      deviceUuid: 'chrome',
      devicePlatform: 'chrome',
      deviceManufacturer: 'mac',
      deviceModel: 'desktop',
      deviceVersion: '145.0.0.0',
    });
  });

  it('coerces semel and year to numbers', () => {
    const body = buildLoginBody({
      ...base,
      semel: '12345' as unknown as number,
      year: '2027' as unknown as number,
    });
    expect(body.semel).toBe(12345);
    expect(body.year).toBe(2027);
  });

  it('omits captcha entirely when none is supplied', () => {
    expect('captcha' in buildLoginBody(base)).toBe(false);
  });

  it('forwards a captcha token verbatim when supplied', () => {
    expect(buildLoginBody({ ...base, captcha: 'tok.en-123' }).captcha).toBe('tok.en-123');
  });

  it('omits an empty captcha rather than sending a blank field', () => {
    expect('captcha' in buildLoginBody({ ...base, captcha: '' })).toBe(false);
  });

  it('omits isPrivateDevice when not supplied', () => {
    expect('isPrivateDevice' in buildLoginBody(base)).toBe(false);
  });

  it('forwards isPrivateDevice when supplied, including false', () => {
    expect(buildLoginBody({ ...base, isPrivateDevice: true }).isPrivateDevice).toBe(true);
    expect(buildLoginBody({ ...base, isPrivateDevice: false }).isPrivateDevice).toBe(false);
  });

  it('omits password entirely when none is supplied', () => {
    // POST /api/login/mfa/verify strips the password from the login data
    // before posting; a `password: undefined` key would still serialise the
    // field on some axios transforms, so it must be absent.
    expect('password' in buildLoginBody({ ...base, password: undefined })).toBe(false);
  });

  it('defaults IsBiometric to false and honours an override', () => {
    expect(buildLoginBody(base).IsBiometric).toBe(false);
    expect(buildLoginBody({ ...base, IsBiometric: true }).IsBiometric).toBe(true);
  });
});

describe('MASHOV_CSRF_TOKEN', () => {
  it('is the literal all three previous copies hard-coded', () => {
    expect(MASHOV_CSRF_TOKEN).toBe('9c690c16-d0c8-ed43-9314-d622077e2e26');
  });
});
