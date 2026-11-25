import { Global, Module } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import {
  ADMIN_AUTH_CONFIG,
  loadAdminAuthConfig,
  type AdminAuthConfig,
} from './admin-auth.config';
import { ADMIN_ACCESS_JWKS, CloudflareAccessGuard } from './cloudflare-access.guard';

/**
 * The operator authorization boundary, as its own module.
 *
 * `@Global()` so an admin feature module can `@UseGuards(CloudflareAccessGuard)`
 * without importing anything -- the guard has exactly one configuration and
 * there is nothing per-feature to wire. The guard is deliberately NOT an
 * `APP_GUARD`: it must apply to the admin controllers only, while every
 * parent-facing route keeps `AppSessionGuard` as its gate.
 *
 * The config is loaded once at boot, from the environment, by a factory that
 * throws on the one unsafe combination (`ADMIN_AUTH_MODE=insecure-dev` without
 * `ENABLE_E2E_AUTH_BYPASS=1`). A throw here fails Nest's boot, which is the
 * intent: the process must refuse to come up with verification switched off
 * rather than serve every parent's report to anyone who finds the origin.
 *
 * See ADR-0045 and docs/ops/admin-access-setup.md.
 */
@Global()
@Module({
  providers: [
    {
      provide: ADMIN_AUTH_CONFIG,
      useFactory: (): AdminAuthConfig => loadAdminAuthConfig(),
    },
    {
      // Built once here rather than inside the guard, so the key source is an
      // injectable seam: the integration test substitutes a LOCAL JWK set and
      // no test ever calls Cloudflare. `createRemoteJWKSet` caches and
      // refreshes on its own, so one instance per process is correct.
      provide: ADMIN_ACCESS_JWKS,
      inject: [ADMIN_AUTH_CONFIG],
      useFactory: (config: AdminAuthConfig): JWTVerifyGetKey | null =>
        config.mode === 'verify' && config.accessTeamDomain
          ? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.accessTeamDomain))
          : null,
    },
    CloudflareAccessGuard,
  ],
  exports: [ADMIN_AUTH_CONFIG, ADMIN_ACCESS_JWKS, CloudflareAccessGuard],
})
export class AdminAuthModule {}
