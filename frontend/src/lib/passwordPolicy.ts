import { z } from 'zod';

/**
 * Mashov's student password policy, on the client.
 *
 * A deliberate verbatim duplicate of
 * `backend/src/common/mashov-login/password-policy.ts`, including the test
 * table. Two runtimes, no shared package: four regexes copied twice is cheaper
 * than a workspace package, and the identical table on both sides is what
 * proves the copies agree.
 *
 * They have to agree, because `POST /api/user/reset/{code}` answers `404` for a
 * policy violation exactly as it does for a bad code. A client that lets a weak
 * password through sends the parent an unhelpable "wrong code" on a code that
 * was right and cannot be reused. Which is why `PASSWORD_RULES` exists as a
 * LIVE CHECKLIST rather than only as submit-time validation: the parent should
 * never be able to press the button on a password that cannot work.
 */

export type PasswordRuleId = 'minLength' | 'letter' | 'digit' | 'noUsername';

export interface PasswordRule {
  id: PasswordRuleId;
  /** Hebrew, rendered as a checklist item while the parent types. */
  message: string;
  test(password: string, username?: string): boolean;
}

export const MIN_PASSWORD_LENGTH = 6;

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'minLength',
    message: 'לפחות 6 תווים',
    test: (password) => password.length >= MIN_PASSWORD_LENGTH,
  },
  {
    id: 'letter',
    // Latin specifically, not `\p{L}` -- see the backend copy for why too
    // strict is the safe direction here.
    message: 'לפחות אות אחת באנגלית',
    test: (password) => /[A-Za-z]/.test(password),
  },
  {
    id: 'digit',
    message: 'לפחות ספרה אחת',
    test: (password) => /[0-9]/.test(password),
  },
  {
    id: 'noUsername',
    message: 'הסיסמה לא יכולה להכיל את שם המשתמש',
    test: (password, username) => {
      if (!username) return true;
      return !password.toLowerCase().includes(username.toLowerCase());
    },
  },
];

/** Every rule the password breaks right now. Drives the live checklist. */
export function brokenRules(password: string, username?: string): PasswordRuleId[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password, username)).map(
    (rule) => rule.id,
  );
}

/**
 * A schema FACTORY, not a constant schema: the last rule is relational, so the
 * username has to be bound in.
 */
export function passwordSchema(username?: string): z.ZodType<string> {
  return PASSWORD_RULES.reduce<z.ZodType<string>>(
    (schema, rule) =>
      schema.refine((password) => rule.test(password, username), {
        message: rule.message,
      }),
    z.string(),
  );
}

/**
 * The shared test table, identical to the backend's `PASSWORD_POLICY_CASES`.
 * Exported from here rather than from the test so a diff against the backend
 * copy is a diff of two source files.
 */
export const PASSWORD_POLICY_CASES: ReadonlyArray<{
  password: string;
  username?: string;
  valid: boolean;
  broken?: PasswordRuleId;
}> = [
  // Happy paths.
  { password: 'secret1', username: '303977367', valid: true },
  { password: 'abc123', username: '303977367', valid: true },
  { password: 'A1bcde', username: 'parent', valid: true },
  { password: 'passw0rd!', username: 'parent', valid: true },
  { password: 'secret1', valid: true },

  // Too short — exactly at and below the boundary.
  { password: 'abc12', username: 'parent', valid: false, broken: 'minLength' },
  { password: '', username: 'parent', valid: false, broken: 'minLength' },
  { password: 'a1', username: 'parent', valid: false, broken: 'minLength' },

  // No letter.
  { password: '123456', username: 'parent', valid: false, broken: 'letter' },
  { password: '1234567890', username: 'parent', valid: false, broken: 'letter' },
  // Hebrew letters do not satisfy the latin-letter rule; see the rule comment.
  { password: 'סיסמה12', username: 'parent', valid: false, broken: 'letter' },

  // No digit.
  { password: 'abcdef', username: 'parent', valid: false, broken: 'digit' },
  { password: 'Password', username: 'parent', valid: false, broken: 'digit' },

  // Contains the username, in either case.
  { password: 'parent1', username: 'parent', valid: false, broken: 'noUsername' },
  { password: 'xPARENT1', username: 'parent', valid: false, broken: 'noUsername' },
  { password: 'aparent1', username: 'PARENT', valid: false, broken: 'noUsername' },
  {
    password: 'a303977367',
    username: '303977367',
    valid: false,
    broken: 'noUsername',
  },
];
