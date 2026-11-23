import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Mashov's student password policy, enforced on our side before we post.
 *
 * Why this exists at all: `POST /api/user/reset/{code}` answers `404` for a bad
 * code AND for a policy violation. Those are indistinguishable on the wire. If
 * we do not validate first, a parent holding a CORRECT single-use code and a
 * six-letter password is told the code was wrong — and the code is single-use,
 * so there is no way back. Validating here is what makes a 404 unambiguously
 * "wrong code".
 *
 * The same four rules are duplicated in `frontend/src/lib/passwordPolicy.ts`,
 * with `PASSWORD_POLICY_CASES` copied verbatim into its test. Two runtimes, no
 * shared package: four regexes and one table beat a workspace package here,
 * and the duplicated table is what proves the copies agree.
 */

export type PasswordRuleId = 'minLength' | 'letter' | 'digit' | 'noUsername';

export interface PasswordRule {
  id: PasswordRuleId;
  /** Hebrew, shown as a live checklist item while the parent types. */
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
    // Latin specifically, not `\p{L}`. Mashov's own check appears to be a
    // latin-letter class, and the asymmetry matters: too strict rejects a
    // password Mashov would have taken, with an explanation the parent can act
    // on; too lax lets them through to a 404 they cannot interpret at all.
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
    // Relational, which is why the frontend copy is a schema *factory* taking
    // the username rather than a constant schema.
    message: 'הסיסמה לא יכולה להכיל את שם המשתמש',
    test: (password, username) => {
      if (!username) return true;
      return !password.toLowerCase().includes(username.toLowerCase());
    },
  },
];

export interface PolicyViolation {
  field: 'newPassword';
  rule: PasswordRuleId;
  message: string;
}

/**
 * Every rule the password breaks — all of them, not the first.
 *
 * A live checklist needs the whole set; reporting one at a time walks the
 * parent through four round trips against a single-use code.
 */
export function validatePassword(password: string, username?: string): PolicyViolation[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password, username)).map((rule) => ({
    field: 'newPassword' as const,
    rule: rule.id,
    message: rule.message,
  }));
}

/**
 * Throw `422 WEAK_PASSWORD` unless the password satisfies every rule.
 *
 * The thrown envelope carries the rule ids and their Hebrew copy and nothing
 * else — never the password, which must not reach a log, a breadcrumb, or an
 * error body.
 */
export function assertPasswordPolicy(password: string, username?: string): void {
  const violations = validatePassword(password, username);
  if (violations.length === 0) return;

  throw new HttpException(
    {
      error: {
        code: 'WEAK_PASSWORD',
        message: 'The new password does not meet the Mashov password policy',
        details: violations.map((violation) => ({
          field: violation.field,
          message: violation.message,
        })),
      },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * The shared test table. Exported from the implementation, not the spec, so
 * the frontend copy can be diffed against one canonical list.
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
