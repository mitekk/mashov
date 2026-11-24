import { ADMIN_AUTH_MODES, AdminAuthConfigError, loadAdminAuthConfig } from './admin-auth.config';

describe('loadAdminAuthConfig', () => {
  const ACCESS = {
    ACCESS_AUD: 'a'.repeat(64),
    ACCESS_TEAM_DOMAIN: 'https://mitya.cloudflareaccess.com',
  };

  describe('mode', () => {
    it('defaults to verify when ADMIN_AUTH_MODE is unset', () => {
      expect(loadAdminAuthConfig({ ...ACCESS }).mode).toBe('verify');
    });

    it('defaults to verify when ADMIN_AUTH_MODE is blank', () => {
      expect(loadAdminAuthConfig({ ADMIN_AUTH_MODE: '   ', ...ACCESS }).mode).toBe('verify');
    });

    it.each(['production', 'off', 'Verify ', 'true', '1'])(
      'refuses an unrecognised ADMIN_AUTH_MODE %p rather than guessing',
      (mode) => {
        expect(() => loadAdminAuthConfig({ ADMIN_AUTH_MODE: mode, ...ACCESS })).toThrow(
          AdminAuthConfigError,
        );
      },
    );

    it('names only the two real modes', () => {
      expect([...ADMIN_AUTH_MODES]).toEqual(['verify', 'insecure-dev']);
    });
  });

  describe('verify mode', () => {
    it('is ready when both Access values are present', () => {
      const config = loadAdminAuthConfig({ ADMIN_AUTH_MODE: 'verify', ...ACCESS });
      expect(config).toMatchObject({
        mode: 'verify',
        ready: true,
        accessAud: ACCESS.ACCESS_AUD,
        accessTeamDomain: ACCESS.ACCESS_TEAM_DOMAIN,
      });
    });

    it('trims both Access values', () => {
      const config = loadAdminAuthConfig({
        ACCESS_AUD: `  ${ACCESS.ACCESS_AUD}  `,
        ACCESS_TEAM_DOMAIN: ` ${ACCESS.ACCESS_TEAM_DOMAIN} `,
      });
      expect(config.accessAud).toBe(ACCESS.ACCESS_AUD);
      expect(config.accessTeamDomain).toBe(ACCESS.ACCESS_TEAM_DOMAIN);
    });

    it('drops a trailing slash from the team domain so the issuer matches', () => {
      const config = loadAdminAuthConfig({
        ...ACCESS,
        ACCESS_TEAM_DOMAIN: 'https://mitya.cloudflareaccess.com/',
      });
      expect(config.accessTeamDomain).toBe('https://mitya.cloudflareaccess.com');
    });

    it.each([
      ['ACCESS_AUD missing', { ACCESS_TEAM_DOMAIN: ACCESS.ACCESS_TEAM_DOMAIN }],
      ['ACCESS_AUD blank', { ...ACCESS, ACCESS_AUD: '  ' }],
      ['ACCESS_TEAM_DOMAIN missing', { ACCESS_AUD: ACCESS.ACCESS_AUD }],
      ['ACCESS_TEAM_DOMAIN blank', { ...ACCESS, ACCESS_TEAM_DOMAIN: '' }],
      ['ACCESS_TEAM_DOMAIN not a url', { ...ACCESS, ACCESS_TEAM_DOMAIN: 'mitya.cloudflareaccess.com' }],
      ['ACCESS_TEAM_DOMAIN not https', { ...ACCESS, ACCESS_TEAM_DOMAIN: 'http://mitya.cloudflareaccess.com' }],
      ['nothing configured at all', {}],
    ])('is NOT ready when %s, and boots anyway', (_label, env) => {
      // Closed, not open, and not fatal: the admin guard answers 403 for every
      // request while the rest of the app -- every parent-facing route -- keeps
      // serving. A prod deploy that forgets the Access vars shows no reports;
      // a dev stack that never had them still boots.
      const config = loadAdminAuthConfig(env);
      expect(config.mode).toBe('verify');
      expect(config.ready).toBe(false);
    });
  });

  describe('insecure-dev mode', () => {
    it('is accepted when ENABLE_E2E_AUTH_BYPASS is also 1', () => {
      const config = loadAdminAuthConfig({
        ADMIN_AUTH_MODE: 'insecure-dev',
        ENABLE_E2E_AUTH_BYPASS: '1',
      });
      expect(config).toMatchObject({ mode: 'insecure-dev', ready: true });
    });

    it('needs no Access values', () => {
      const config = loadAdminAuthConfig({
        ADMIN_AUTH_MODE: 'insecure-dev',
        ENABLE_E2E_AUTH_BYPASS: '1',
      });
      expect(config.accessAud).toBeNull();
      expect(config.accessTeamDomain).toBeNull();
    });

    it.each([
      ['ENABLE_E2E_AUTH_BYPASS unset', {}],
      ['ENABLE_E2E_AUTH_BYPASS=0', { ENABLE_E2E_AUTH_BYPASS: '0' }],
      ['ENABLE_E2E_AUTH_BYPASS=true', { ENABLE_E2E_AUTH_BYPASS: 'true' }],
      ['ENABLE_E2E_AUTH_BYPASS blank', { ENABLE_E2E_AUTH_BYPASS: ' ' }],
    ])('refuses to boot when the mode is insecure-dev and %s', (_label, env) => {
      // This is the one genuinely unsafe combination: an explicit request to
      // skip JWT verification. It must stop the process rather than quietly
      // serve every report to anyone who finds the origin IP.
      expect(() =>
        loadAdminAuthConfig({ ADMIN_AUTH_MODE: 'insecure-dev', ...env }),
      ).toThrow(AdminAuthConfigError);
    });

    it('refuses even when the Access values are also present', () => {
      expect(() =>
        loadAdminAuthConfig({ ADMIN_AUTH_MODE: 'insecure-dev', ...ACCESS }),
      ).toThrow(AdminAuthConfigError);
    });

    it('never names a value in the refusal', () => {
      try {
        loadAdminAuthConfig({ ADMIN_AUTH_MODE: 'insecure-dev', ACCESS_AUD: 'secret-aud' });
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error).message).not.toContain('secret-aud');
      }
    });
  });
});
