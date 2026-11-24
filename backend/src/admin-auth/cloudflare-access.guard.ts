import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ADMIN_AUTH_CONFIG, type AdminAuthConfig } from './admin-auth.config';

declare module 'express' {
  interface Request {
    /**
     * The operator's email, from VERIFIED Access claims only. Never read from
     * a header or a body -- `Cf-Access-Authenticated-User-Email` is a header
     * anyone reaching the origin directly can set.
     */
    adminEmail?: string;
  }
}

/** Cloudflare Access forwards the signed assertion under this header. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * The key resolver, injected rather than constructed here.
 *
 * `AdminAuthModule` provides the remote JWKS at
 * `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`; the specs and the integration
 * test substitute a LOCAL JWK set, so no test makes a network call. Null means
 * there is nothing to verify against, and the guard refuses everything.
 */
export const ADMIN_ACCESS_JWKS = 'ADMIN_ACCESS_JWKS';

/**
 * Verifies the Cloudflare Access JWT in-process.
 *
 * **This is the real authorization boundary, not defense in depth.** A
 * Cloudflare Access policy on `/admin` gates traffic that arrives through
 * Cloudflare -- and this origin is also reachable directly:
 *
 *     curl -sk --resolve mashov.mitya.dev:443:<origin-ip> \
 *       https://mashov.mitya.dev/api/health   ->  200
 *
 * So anyone who knows the origin IP walks straight past the Access policy, and
 * this guard is the only thing standing between them and every parent's
 * report. Closing the origin to Cloudflare's IP ranges is a required ops
 * follow-up (docs/ops/admin-access-setup.md step 5), not a substitute for
 * this. See ADR-0045.
 *
 * Every refusal is **403, never 401**. `frontend/src/api/client.ts` turns a
 * 401 into a hard redirect to the PARENT sign-in page, so a 401 here would
 * bounce an operator out of the admin surface and read as a broken screen
 * rather than a refused request.
 *
 * The underlying `jose` reason is never surfaced. "wrong audience" versus
 * "expired" versus "unknown key" tells a prober which part of their forgery
 * to fix.
 */
@Injectable()
export class CloudflareAccessGuard implements CanActivate {
  private readonly logger = new Logger(CloudflareAccessGuard.name);

  private readonly keys: JWTVerifyGetKey | null;

  constructor(
    @Inject(ADMIN_AUTH_CONFIG) private readonly config: AdminAuthConfig,
    // `@Optional()` so the guard is still constructible by hand in a unit
    // spec; in the app the module always provides it (possibly as null).
    @Optional() @Inject(ADMIN_ACCESS_JWKS) keys?: JWTVerifyGetKey | null,
  ) {
    this.keys = keys ?? null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (this.config.mode === 'insecure-dev') {
      // Accepted only alongside ENABLE_E2E_AUTH_BYPASS=1; see
      // admin-auth.config.ts, which refuses to boot otherwise.
      request.adminEmail = 'dev@insecure.local';
      return true;
    }

    if (!this.config.ready || !this.keys || !this.config.accessAud) {
      // Unconfigured means closed, not open. Logged at warn rather than error:
      // on a dev stack this is the expected state, not a fault.
      this.logger.warn(
        'Refusing an admin request: ADMIN_AUTH_MODE=verify but ACCESS_AUD / ' +
          'ACCESS_TEAM_DOMAIN are not configured.',
      );
      throw this.forbidden();
    }

    const token = this.extractToken(request);
    if (!token) throw this.forbidden();

    try {
      const { payload } = await jwtVerify(token, this.keys, {
        // Pinned, so the verifier can never be steered onto a weaker or
        // unexpected algorithm the JWKS happens to advertise.
        algorithms: ['RS256'],
        audience: this.config.accessAud,
        issuer: this.config.accessTeamDomain as string,
      });
      const email = (payload as Record<string, unknown>).email;
      request.adminEmail = typeof email === 'string' && email.length > 0 ? email : undefined;
      return true;
    } catch {
      // Missing / invalid / expired / wrong-audience / unreachable-JWKS all
      // collapse to the same generic refusal.
      throw this.forbidden();
    }
  }

  private extractToken(request: Request): string | null {
    const header = request.headers[ACCESS_JWT_HEADER];
    const raw = Array.isArray(header) ? header[0] : header;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  }

  private forbidden(): ForbiddenException {
    return new ForbiddenException({
      error: {
        code: 'FORBIDDEN',
        message: 'Operator access required',
        details: [],
      },
    });
  }
}
