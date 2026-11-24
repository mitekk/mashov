import { appVersion, PACKAGE_VERSION } from './app-version';

/**
 * Which build this process is.
 *
 * The default comes from the backend's own package.json, so a stack needs no
 * configuration to record something. `APP_VERSION` overrides it, which is how
 * CI or ops stamp a real build (a tag, a git sha) onto a deployment -- the
 * package.json version in this repo has not moved since the file was created,
 * so on its own it cannot tell two builds apart.
 */
describe('appVersion', () => {
  const original = process.env.APP_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = original;
  });

  it('finds a version in the backend package.json', () => {
    // Not asserting the number: it changes. Asserting the file was actually
    // located and parsed, which is the part that breaks when dist/ moves.
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults to the package version when nothing is configured', () => {
    delete process.env.APP_VERSION;

    expect(appVersion()).toBe(PACKAGE_VERSION);
  });

  it('prefers an explicitly configured version', () => {
    process.env.APP_VERSION = '2026.11.24-abc1234';

    expect(appVersion()).toBe('2026.11.24-abc1234');
  });

  it('ignores the empty string compose hands it when the operator set nothing', () => {
    // `APP_VERSION: ${APP_VERSION:-}` yields a SET empty string, not an absent
    // one, so this is the default path rather than an edge case.
    process.env.APP_VERSION = '';

    expect(appVersion()).toBe(PACKAGE_VERSION);
  });

  it('ignores whitespace for the same reason', () => {
    process.env.APP_VERSION = '   ';

    expect(appVersion()).toBe(PACKAGE_VERSION);
  });

  it('trims a configured version rather than storing the padding', () => {
    process.env.APP_VERSION = '  1.2.3  ';

    expect(appVersion()).toBe('1.2.3');
  });
});
