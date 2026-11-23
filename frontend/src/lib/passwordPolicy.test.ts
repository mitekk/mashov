import { describe, expect, it } from 'vitest';
import {
  PASSWORD_POLICY_CASES,
  PASSWORD_RULES,
  brokenRules,
  passwordSchema,
} from './passwordPolicy';

/**
 * The SAME table as `backend/src/common/mashov-login/password-policy.spec.ts`,
 * copied verbatim.
 *
 * The duplication is deliberate: two runtimes, no shared package, and four
 * regexes plus one table copied twice is cheaper than a workspace package. The
 * table being identical on both sides is what proves the copies agree -- and
 * they have to, because Mashov answers `404` for a policy violation exactly as
 * it does for a bad recovery code, so a client that lets a bad password through
 * sends the parent an unhelpable error on a single-use code.
 */
describe('brokenRules', () => {
  for (const testCase of PASSWORD_POLICY_CASES) {
    const label = testCase.valid ? 'accepts' : `rejects (${testCase.broken})`;
    it(`${label} ${JSON.stringify(testCase.password)} for username ${JSON.stringify(
      testCase.username,
    )}`, () => {
      const broken = brokenRules(testCase.password, testCase.username);
      if (testCase.valid) {
        expect(broken).toEqual([]);
      } else {
        expect(broken).toContain(testCase.broken);
      }
    });
  }

  it('reports every broken rule at once, for the live checklist', () => {
    expect(brokenRules('abc', 'abc').sort()).toEqual([
      'digit',
      'minLength',
      'noUsername',
    ]);
  });

  it('skips the username rule when no username is known', () => {
    expect(brokenRules('secret1')).toEqual([]);
    expect(brokenRules('secret1', '')).toEqual([]);
  });
});

describe('PASSWORD_RULES', () => {
  it('exposes the four rules in checklist order, matching the backend', () => {
    expect(PASSWORD_RULES.map((rule) => rule.id)).toEqual([
      'minLength',
      'letter',
      'digit',
      'noUsername',
    ]);
  });

  it('gives every rule Hebrew copy', () => {
    for (const rule of PASSWORD_RULES) {
      expect(rule.message).toMatch(/[֐-׿]/);
    }
  });
});

describe('passwordSchema', () => {
  it('is a factory over the username, because the last rule is relational', () => {
    expect(passwordSchema('parent').safeParse('parent1').success).toBe(false);
    expect(passwordSchema('other').safeParse('parent1').success).toBe(true);
  });

  it('accepts a compliant password', () => {
    expect(passwordSchema('303977367').safeParse('secret1').success).toBe(true);
  });

  it('reports Hebrew messages a form can render inline', () => {
    const result = passwordSchema('parent').safeParse('abc');
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const issue of result.error.issues) {
        expect(issue.message).toMatch(/[֐-׿]/);
      }
    }
  });
});
