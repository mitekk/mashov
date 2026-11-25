/**
 * The admin surface's environment contract.
 *
 * Modelled on the one working Cloudflare Access implementation on this
 * machine (`thiland-trip/services/plan-api/src/config.ts`), with one
 * deliberate difference in where it fails.
 *
 * There are two different kinds of bad configuration here and they deserve
 * different answers:
 *
 *  - **Unusable**: `verify` mode with no `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`.
 *    Nothing can be verified, so nothing is served: `ready: false`, and the
 *    guard answers 403 to every admin request. This is fail-closed and it is
 *    NOT fatal -- `verify` is the default, the Access values live in the
 *    Coolify UI, and no dev stack has them. Taking the whole backend down
 *    (every parent-facing route with it) because an operator-only screen is
 *    unconfigured would be the wrong trade. A prod deploy that forgets them
 *    shows an operator an empty, 403ing screen -- loud enough, and safe.
 *
 *  - **Unsafe**: `insecure-dev`, which skips JWT verification entirely. That
 *    is an explicit request to disable the real authorization boundary, so it
 *    refuses to boot unless `ENABLE_E2E_AUTH_BYPASS=1` is ALSO set. Two
 *    independent switches, both default off. The second one is reused rather
 *    than invented: `docker-compose.yml` already documents it as "must stay 0
 *    everywhere else", and a single concept with one meaning beats two flags
 *    an operator has to keep straight.
 *
 * `NODE_ENV` is deliberately not part of either rule. This project's
 * production compose never sets it, so a `NODE_ENV !== 'production'` guard
 * would pass in production -- worse than no guard, because it would read like
 * one.
 *
 * See ADR-0045.
 */

/** The only two modes. An unrecognised value is refused, never guessed at. */
export const ADMIN_AUTH_MODES = ['verify', 'insecure-dev'] as const;

export type AdminAuthMode = (typeof ADMIN_AUTH_MODES)[number];

/** Thrown for an unsafe combination. Never carries a configured value. */
export class AdminAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminAuthConfigError';
  }
}

export interface AdminAuthConfig {
  mode: AdminAuthMode;
  /** The Cloudflare Access application's AUD tag. Null in `insecure-dev`. */
  accessAud: string | null;
  /** `https://<team>.cloudflareaccess.com`, no trailing slash. */
  accessTeamDomain: string | null;
  /**
   * Whether the guard can actually decide anything. False means every admin
   * request is refused with 403 -- see the "unusable" case above.
   */
  ready: boolean;
}

/** Nest token: the guard takes the loaded config rather than reading env. */
export const ADMIN_AUTH_CONFIG = 'ADMIN_AUTH_CONFIG';

function trimmed(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * `https` only, because this is the JWKS origin and the token issuer. A
 * trailing slash comes off so the value compares equal to the `iss` claim,
 * which Cloudflare writes without one.
 */
function teamDomain(raw: string | undefined): string | null {
  const value = trimmed(raw);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return value.replace(/\/+$/, '');
}

export function loadAdminAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminAuthConfig {
  const rawMode = trimmed(env.ADMIN_AUTH_MODE) ?? 'verify';
  if (!(ADMIN_AUTH_MODES as readonly string[]).includes(rawMode)) {
    throw new AdminAuthConfigError(
      `Invalid ADMIN_AUTH_MODE "${rawMode}" -- expected ${ADMIN_AUTH_MODES.map(
        (mode) => `"${mode}"`,
      ).join(' or ')}.`,
    );
  }
  const mode = rawMode as AdminAuthMode;

  if (mode === 'insecure-dev') {
    // The one fatal case. Note it refuses even when the Access values are
    // present: having them does not make skipping them safe.
    if (trimmed(env.ENABLE_E2E_AUTH_BYPASS) !== '1') {
      throw new AdminAuthConfigError(
        'ADMIN_AUTH_MODE=insecure-dev skips Cloudflare Access JWT verification and is ' +
          'accepted only when ENABLE_E2E_AUTH_BYPASS=1 is also set. Both switches default ' +
          'off; set neither in production.',
      );
    }
    return { mode, accessAud: null, accessTeamDomain: null, ready: true };
  }

  const accessAud = trimmed(env.ACCESS_AUD);
  const accessTeamDomain = teamDomain(env.ACCESS_TEAM_DOMAIN);

  return {
    mode,
    accessAud,
    accessTeamDomain,
    ready: accessAud !== null && accessTeamDomain !== null,
  };
}
