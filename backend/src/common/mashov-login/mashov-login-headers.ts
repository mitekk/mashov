/**
 * Reading the session material Mashov returns in response headers.
 *
 * Extracted from `MashovCredentialValidatorService` so the recovery/MFA client
 * reads the same fields the same way: `POST /api/login`,
 * `POST /api/login/mfa/verify` and `POST /api/loginDevice` all answer with the
 * same `uniquId` cookie, `X-Csrf-Token` and `devicePass` triple, and a second
 * hand-written reader is how one of them quietly stops capturing `devicePass`.
 */

/** What every Mashov login-shaped response carries alongside its body. */
export interface MashovLoginHeaders {
  /** The `uniquId` cookie, if the response set one. */
  newUniqueId: string | undefined;
  /** The `X-Csrf-Token` response header, if Mashov sent one. */
  csrfToken: string | undefined;
  /**
   * The `devicePass` response header, if Mashov sent one.
   *
   * The trusted-device credential: `POST /api/loginDevice` with an empty body
   * and this header re-logs in WITHOUT re-triggering an MFA challenge. It is
   * what makes an MFA-protected account compatible with our cron re-logins.
   */
  devicePass: string | undefined;
}

/**
 * One response header, whatever case the server or the transport chose.
 *
 * Axios lowercases header names on the Node adapter but not everywhere, and
 * `devicePass` is spelled mixed-case in Mashov's own bundle. A case-sensitive
 * read would silently return `undefined` and quietly disable the
 * trusted-device path — which fails as "MFA accounts stopped syncing" a day
 * later rather than as an error anyone can see.
 */
export function readResponseHeader(
  headers: Record<string, unknown> | undefined,
  lowercaseName: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowercaseName) continue;
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

/** The `uniquId` Mashov set, if it set one. */
export function readUniqueIdCookie(
  setCookie: string | string[] | undefined,
): string | undefined {
  if (!setCookie) return undefined;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of cookies) {
    const nameValue = cookie.split(';')[0] ?? '';
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx !== -1 && nameValue.substring(0, eqIdx).trim() === 'uniquId') {
      return nameValue.substring(eqIdx + 1).trim();
    }
  }
  return undefined;
}

/** All three, from one response's headers. */
export function readLoginHeaders(
  headers: Record<string, unknown> | undefined,
): MashovLoginHeaders {
  return {
    newUniqueId: readUniqueIdCookie(
      headers?.['set-cookie'] as string | string[] | undefined,
    ),
    csrfToken: readResponseHeader(headers, 'x-csrf-token'),
    devicePass: readResponseHeader(headers, 'devicepass'),
  };
}
