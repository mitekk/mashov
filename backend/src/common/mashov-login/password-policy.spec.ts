import { HttpException } from '@nestjs/common';
import {
  PASSWORD_POLICY_CASES,
  PASSWORD_RULES,
  assertPasswordPolicy,
  validatePassword,
} from './password-policy';

/**
 * Mashov's student password policy, enforced here BEFORE we post anything.
 *
 * This is load-bearing rather than cosmetic: `POST /api/user/reset/{code}`
 * answers `404` for a bad code AND for a policy violation. Validating first is
 * the only thing that makes a 404 unambiguously "wrong code" — otherwise a
 * parent with a correct code and a six-letter password is told their code was
 * wrong, and the code is single-use, so they cannot recover from that.
 *
 * `PASSWORD_POLICY_CASES` is exported and duplicated verbatim in
 * `frontend/src/lib/passwordPolicy.test.ts`. Two runtimes, no shared package:
 * four regexes and one table copied twice is cheaper than a workspace package,
 * and the duplicated table is what proves the two copies agree.
 */
describe('validatePassword', () => {
  for (const testCase of PASSWORD_POLICY_CASES) {
    const label = testCase.valid ? 'accepts' : `rejects (${testCase.broken})`;
    it(`${label} ${JSON.stringify(testCase.password)} for username ${JSON.stringify(
      testCase.username,
    )}`, () => {
      const violations = validatePassword(testCase.password, testCase.username);
      if (testCase.valid) {
        expect(violations).toEqual([]);
      } else {
        expect(violations.map((violation) => violation.rule)).toContain(testCase.broken);
      }
    });
  }

  it('reports every broken rule at once, not just the first', () => {
    // A live checklist in the UI needs all of them; reporting one at a time
    // walks the parent through four round trips.
    const violations = validatePassword('abc', 'abc');
    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      'digit',
      'minLength',
      'noUsername',
    ]);
  });

  it('skips the username rule when no username is known', () => {
    expect(validatePassword('secret1')).toEqual([]);
    expect(validatePassword('secret1', '')).toEqual([]);
  });

  it('gives every violation Hebrew copy a parent can act on', () => {
    for (const violation of validatePassword('a', 'a')) {
      expect(violation.message).toMatch(/[֐-׿]/);
      expect(violation.field).toBe('newPassword');
    }
  });
});

describe('PASSWORD_RULES', () => {
  it('exposes the four rules, in checklist order', () => {
    expect(PASSWORD_RULES.map((rule) => rule.id)).toEqual([
      'minLength',
      'letter',
      'digit',
      'noUsername',
    ]);
  });

  it('gives each rule Hebrew copy for the live checklist', () => {
    for (const rule of PASSWORD_RULES) {
      expect(rule.message).toMatch(/[֐-׿]/);
    }
  });
});

describe('assertPasswordPolicy', () => {
  it('passes a compliant password through silently', () => {
    expect(() => assertPasswordPolicy('secret1', 'someuser')).not.toThrow();
  });

  it('throws 422 WEAK_PASSWORD with one detail per broken rule', () => {
    let thrown: HttpException | undefined;
    try {
      assertPasswordPolicy('abc', 'abc');
    } catch (err) {
      thrown = err as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown?.getStatus()).toBe(422);
    const body = thrown?.getResponse() as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    expect(body.error.code).toBe('WEAK_PASSWORD');
    expect(body.error.details).toHaveLength(3);
    for (const detail of body.error.details) {
      expect(detail.field).toBe('newPassword');
      expect(detail.message).toMatch(/[֐-׿]/);
    }
  });

  it('never puts the password itself in the error it throws', () => {
    try {
      assertPasswordPolicy('hunter2secret', 'hunter2secret');
    } catch (err) {
      expect(JSON.stringify((err as HttpException).getResponse())).not.toContain(
        'hunter2secret',
      );
    }
  });
});
