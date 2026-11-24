/**
 * The one `POST /api/login` request body, and the one CSRF literal.
 *
 * This existed in three hand-written copies — `AuthService.postLogin`,
 * `MashovSessionService.postSharedLogin` and
 * `MashovSessionService.loginWithCredentials` — plus the canonical
 * `MashovCredentialValidatorService`. Four copies of the fourteen fields
 * Mashov's own `prepareLoginData` sends, each free to drift. The recovery, MFA
 * and captcha surfaces all have to add a field to this body, and a field added
 * to three of four copies is a sign-in that works on one route and not another.
 *
 * Field names and values are Mashov's, not ours: `IsBiometric` really is
 * capitalised while `isPrivateDevice` is not, and `appVersion`/`appBuild` are
 * numbers while `apiVersion` is a string. Preserved verbatim.
 */

/**
 * Lifted from the Angular bundle, where it is a hard-coded constant rather
 * than a per-session token. Mashov validates its presence, not its value.
 */
export const MASHOV_CSRF_TOKEN = '9c690c16-d0c8-ed43-9314-d622077e2e26';

export interface LoginBodyInput {
  semel: number;
  year: number;
  username: string;
  /**
   * Absent for the flows that post the login data *without* a password:
   * `POST /api/login/mfa/verify` strips it before sending.
   */
  password?: string;
  /** A Turnstile token, only ever present after Mashov asked for one. */
  captcha?: string;
  isPrivateDevice?: boolean;
  IsBiometric?: boolean;
}

/**
 * Build the login body. Optional fields are **omitted**, not set to
 * `undefined`: this body is also used as the base for `mfa/verify`, where a
 * present-but-empty `password` is not the same thing as no password.
 */
export function buildLoginBody(input: LoginBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    semel: Number(input.semel),
    year: Number(input.year),
    username: input.username,
  };

  if (input.password !== undefined) {
    body.password = input.password;
  }

  body.IsBiometric = input.IsBiometric ?? false;
  body.appName = 'info.mashov.students';
  body.apiVersion = '3.20210425';
  body.appVersion = 3.20210425;
  body.appBuild = 3.20210425;
  body.deviceUuid = 'chrome';
  body.devicePlatform = 'chrome';
  body.deviceManufacturer = 'mac';
  body.deviceModel = 'desktop';
  body.deviceVersion = '145.0.0.0';

  // An empty string is not a captcha. Sending one would be a blank answer to a
  // challenge rather than no answer, and Mashov grades those differently.
  if (input.captcha) {
    body.captcha = input.captcha;
  }
  if (input.isPrivateDevice !== undefined) {
    body.isPrivateDevice = input.isPrivateDevice;
  }

  return body;
}
