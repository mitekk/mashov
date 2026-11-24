import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The workspace half of the version stamp.
 *
 * It lives here rather than in `backend/src` for one blunt reason: the unit
 * suite runs inside an image built with `context: ./backend` and no repo
 * mount, so the CI workflow, docker-compose.yml and the root package.json do
 * not exist in it. The integration suite runs from the repo root with `./`
 * mounted, so it is the only layer in CI that can see these files. It reads
 * them and nothing else -- no database is touched.
 *
 * Asserted rather than trusted because every part of this chain fails
 * SILENTLY: both sides fall back to their package.json version, which is not
 * bumped per release, so a dropped stamp breaks no test and shows up only as a
 * column of identical strings long after the fact.
 */
const ROOT = join(__dirname, '..', '..');
const CI = join(ROOT, '.github', 'workflows', 'ci.yml');
const COMPOSE = join(ROOT, 'docker-compose.yml');
const ROOT_PACKAGE = join(ROOT, 'package.json');

describe('app version stamp — workspace', () => {
  describe('CI', () => {
    const ci = readFileSync(CI, 'utf8');

    it('derives a short git sha rather than using the 40-char github.sha', () => {
      // The client-sent `appVersion` is capped at 40 characters by the DTO, so
      // a full sha leaves no room for a prefix anyone adds later.
      expect(ci).toMatch(/rev-parse --short=\d+ HEAD/);
    });

    /**
     * Every image build, not just the final gate: the e2e job builds the
     * images the suite actually boots, so stamping only `build` would leave
     * the one run that exercises the app unstamped.
     */
    it('stamps every image it builds', () => {
      const builds = ci.match(/uses: docker\/build-push-action/g) ?? [];
      const stamps = ci.match(/build-args:\s*\|?\s*\n\s*APP_VERSION=/g) ?? [];

      expect(builds.length).toBeGreaterThanOrEqual(2);
      expect(stamps).toHaveLength(builds.length);
    });
  });

  describe('compose', () => {
    const compose = readFileSync(COMPOSE, 'utf8');

    it('threads APP_VERSION into the frontend build, where Next inlines it', () => {
      const [, frontend = ''] = compose.split(/^  frontend:$/m);
      expect(frontend).toMatch(/args:[\s\S]*?APP_VERSION: \$\{APP_VERSION:-\}/);
    });

    /**
     * Pass-through, with no value. `${APP_VERSION:-}` would set the variable
     * to an empty string whenever nobody exported one, overriding the version
     * CI baked into the image and sending the backend back to its package.json
     * version -- silently, since empty is exactly what the fallback treats as
     * "unset".
     */
    it('passes APP_VERSION through to the backend rather than blanking it', () => {
      const [, backend = ''] = compose.split(/^  backend:$/m);
      const [beforeNextService = ''] = backend.split(/^  [a-z-]+:$/m);
      expect(beforeNextService).toMatch(/environment:[\s\S]*?\n\s*APP_VERSION:\s*\n/);
      expect(beforeNextService).not.toMatch(/APP_VERSION: \$\{APP_VERSION:-\}/);
    });
  });

  describe('the local build command', () => {
    const scripts = (
      JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    /**
     * CI builds with `load: true` and pushes nothing, and there is no deploy
     * pipeline in this repo, so a CI-only stamp never reaches a running stack.
     * A real deployment is someone running compose, which cannot shell out for
     * a sha -- so the command that does it has to live here.
     */
    it('stamps the running stack with the same short sha CI uses', () => {
      expect(scripts['stack:up']).toMatch(/rev-parse --short=\d+ HEAD/);
      expect(scripts['stack:up']).toMatch(/docker compose .*up --build/);
    });

    /**
     * Pinned to docker-compose.yml, like every other stack script here.
     * Without it the dev override loads, which runs the backend from the
     * `builder` stage under `nest start --watch` -- a different image than the
     * one a deployment runs, and one that shares the same `latest` tag.
     */
    it('builds the production stack, not the dev override', () => {
      expect(scripts['stack:up']).toContain('-f docker-compose.yml');
    });
  });
});
