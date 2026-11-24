import { Test } from '@nestjs/testing';
import { AdminAuthModule } from './admin-auth.module';
import { ADMIN_AUTH_CONFIG, type AdminAuthConfig } from './admin-auth.config';
import { ADMIN_ACCESS_JWKS, CloudflareAccessGuard } from './cloudflare-access.guard';

describe('AdminAuthModule', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.ADMIN_AUTH_MODE;
    delete process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ENABLE_E2E_AUTH_BYPASS;
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('loads the config from the environment and resolves the guard', async () => {
    process.env.ACCESS_AUD = 'a'.repeat(64);
    process.env.ACCESS_TEAM_DOMAIN = 'https://mitya.cloudflareaccess.com';

    const moduleRef = await Test.createTestingModule({ imports: [AdminAuthModule] }).compile();

    expect(moduleRef.get<AdminAuthConfig>(ADMIN_AUTH_CONFIG)).toMatchObject({
      mode: 'verify',
      ready: true,
    });
    expect(moduleRef.get(CloudflareAccessGuard)).toBeInstanceOf(CloudflareAccessGuard);
    // The key source is a provider, not something the guard builds: that is
    // what lets the integration test substitute a local JWK set.
    expect(moduleRef.get(ADMIN_ACCESS_JWKS)).toEqual(expect.any(Function));
  });

  it('boots with the surface closed when the Access values are absent', async () => {
    // Every dev stack is in this state. The app must come up; the admin API
    // must answer 403.
    const moduleRef = await Test.createTestingModule({ imports: [AdminAuthModule] }).compile();

    expect(moduleRef.get<AdminAuthConfig>(ADMIN_AUTH_CONFIG).ready).toBe(false);
    // Nothing to verify against, so there is no key source either.
    expect(moduleRef.get(ADMIN_ACCESS_JWKS)).toBeNull();
  });

  it('refuses to boot when insecure-dev is set without the e2e bypass flag', async () => {
    process.env.ADMIN_AUTH_MODE = 'insecure-dev';

    await expect(
      Test.createTestingModule({ imports: [AdminAuthModule] }).compile(),
    ).rejects.toThrow(/ENABLE_E2E_AUTH_BYPASS/);
  });
});
