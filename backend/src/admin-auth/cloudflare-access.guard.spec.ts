import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { SignJWT, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import type { Request } from 'express';
import { createLocalJWKSet } from 'jose';
import type { AdminAuthConfig } from './admin-auth.config';
import { ACCESS_JWT_HEADER, CloudflareAccessGuard } from './cloudflare-access.guard';

const TEAM = 'https://mitya.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

const VERIFY: AdminAuthConfig = {
  mode: 'verify',
  accessAud: AUD,
  accessTeamDomain: TEAM,
  ready: true,
};

function contextFor(headers: Record<string, string | string[] | undefined>): {
  context: ExecutionContext;
  request: Request;
} {
  const request = { headers } as unknown as Request;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

/**
 * A real RS256 keypair, exported as a local JWK set. The guard takes its key
 * resolver by injection, so this stands in for Cloudflare's
 * /cdn-cgi/access/certs without a network call.
 */
async function signer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256' }] });

  async function sign(
    claims: Record<string, unknown> = {},
    options: { audience?: string | string[]; issuer?: string; expiresIn?: string; alg?: string } = {},
  ): Promise<string> {
    return new SignJWT({ email: 'operator@example.com', ...claims })
      .setProtectedHeader({ alg: options.alg ?? 'RS256' })
      .setIssuedAt()
      .setIssuer(options.issuer ?? TEAM)
      .setAudience(options.audience ?? AUD)
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(privateKey);
  }

  return { keys, sign };
}

async function expectForbidden(
  guard: CloudflareAccessGuard,
  context: ExecutionContext,
): Promise<void> {
  await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  // Never 401: frontend/src/api/client.ts turns a 401 into a hard redirect to
  // the PARENT sign-in page, which would bounce an operator out of the admin
  // surface and look like a broken screen rather than a refused request.
  await guard.canActivate(context).catch((error: ForbiddenException) => {
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({
      error: { code: 'FORBIDDEN', message: expect.any(String), details: [] },
    });
  });
}

describe('CloudflareAccessGuard', () => {
  describe('verify mode', () => {
    let keys: JWTVerifyGetKey;
    let sign: Awaited<ReturnType<typeof signer>>['sign'];

    beforeAll(async () => {
      ({ keys, sign } = await signer());
    });

    function guard(config: AdminAuthConfig = VERIFY): CloudflareAccessGuard {
      return new CloudflareAccessGuard(config, keys);
    }

    it('admits a valid token and takes the email from the verified claims', async () => {
      const { context, request } = contextFor({ [ACCESS_JWT_HEADER]: await sign() });

      await expect(guard().canActivate(context)).resolves.toBe(true);
      expect(request.adminEmail).toBe('operator@example.com');
    });

    it('reads the first value when the header arrives repeated', async () => {
      const token = await sign();
      const { context } = contextFor({ [ACCESS_JWT_HEADER]: [token, 'junk'] });
      await expect(guard().canActivate(context)).resolves.toBe(true);
    });

    it('leaves adminEmail undefined when the token carries no email claim', async () => {
      // Identity comes only from verified claims. A service token has no email
      // and must not be given one.
      const { context, request } = contextFor({
        [ACCESS_JWT_HEADER]: await sign({ email: undefined }),
      });
      await expect(guard().canActivate(context)).resolves.toBe(true);
      expect(request.adminEmail).toBeUndefined();
    });

    it('never takes the email from a header the caller set', async () => {
      const { context, request } = contextFor({
        [ACCESS_JWT_HEADER]: await sign(),
        'cf-access-authenticated-user-email': 'attacker@example.com',
      });
      await guard().canActivate(context);
      expect(request.adminEmail).toBe('operator@example.com');
    });

    it('refuses a request with no token at all', async () => {
      await expectForbidden(guard(), contextFor({}).context);
    });

    it('refuses a blank token', async () => {
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: '   ' }).context);
    });

    it('refuses a malformed token', async () => {
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: 'not.a.jwt' }).context);
    });

    it('refuses a token for another audience', async () => {
      const token = await sign({}, { audience: 'b'.repeat(64) });
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: token }).context);
    });

    it('refuses a token from another issuer', async () => {
      const token = await sign({}, { issuer: 'https://someone-else.cloudflareaccess.com' });
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: token }).context);
    });

    it('refuses an expired token', async () => {
      const token = await sign({}, { expiresIn: '-1m' });
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: token }).context);
    });

    it('refuses a token signed by a key the JWKS does not hold', async () => {
      const other = await signer();
      const token = await other.sign();
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: token }).context);
    });

    it('refuses an unsigned token even though the JWKS would be consulted', async () => {
      // `alg: none` and the HMAC family are the classic downgrades. RS256 is
      // pinned explicitly so the verifier cannot be steered off it.
      const token = await sign({}, { alg: 'RS512' });
      await expectForbidden(guard(), contextFor({ [ACCESS_JWT_HEADER]: token }).context);
    });

    it('refuses everything when the Access values are not configured', async () => {
      const notReady: AdminAuthConfig = {
        mode: 'verify',
        accessAud: null,
        accessTeamDomain: null,
        ready: false,
      };
      const { context } = contextFor({ [ACCESS_JWT_HEADER]: await sign() });
      await expectForbidden(new CloudflareAccessGuard(notReady, undefined), context);
    });

    it('refuses when the key resolver itself fails, e.g. an unreachable JWKS', async () => {
      const failing: JWTVerifyGetKey = () => {
        throw new Error('getaddrinfo ENOTFOUND mitya.cloudflareaccess.com');
      };
      const { context } = contextFor({ [ACCESS_JWT_HEADER]: await sign() });
      await expectForbidden(new CloudflareAccessGuard(VERIFY, failing), context);
    });

    it('never surfaces the underlying jose reason', async () => {
      const { context } = contextFor({ [ACCESS_JWT_HEADER]: 'not.a.jwt' });
      await guard()
        .canActivate(context)
        .catch((error: ForbiddenException) => {
          const body = JSON.stringify(error.getResponse());
          expect(body).not.toMatch(/jose|JWS|JWT|signature|Invalid Compact/i);
        });
    });
  });

  describe('insecure-dev mode', () => {
    const config: AdminAuthConfig = {
      mode: 'insecure-dev',
      accessAud: null,
      accessTeamDomain: null,
      ready: true,
    };

    it('admits an unauthenticated request and synthesizes a dev identity', async () => {
      const { context, request } = contextFor({});
      const guard = new CloudflareAccessGuard(config, undefined);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.adminEmail).toBe('dev@insecure.local');
    });

    it('ignores a token entirely rather than half-verifying it', async () => {
      const { context, request } = contextFor({ [ACCESS_JWT_HEADER]: 'not.a.jwt' });
      const guard = new CloudflareAccessGuard(config, undefined);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.adminEmail).toBe('dev@insecure.local');
    });
  });
});
