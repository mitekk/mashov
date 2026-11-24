import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The backend half of the version stamp, asserted rather than trusted: it is
 * trivially droppable in a Dockerfile edit and dropping it is silent, because
 * `appVersion()` always falls back to the package.json version. Nothing fails;
 * the column just quietly stops distinguishing builds.
 *
 * Only the Dockerfile is checked here. The CI workflow, docker-compose.yml and
 * the root package.json are OUTSIDE this image's build context (`context:
 * ./backend`, no repo mount), so the unit container cannot see them at all --
 * their half lives in tests/integration/app-version-stamp.test.ts, which runs
 * from the repo root.
 */
const DOCKERFILE = join(__dirname, '..', '..', 'Dockerfile');

describe('app version stamp — backend image', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('bakes APP_VERSION in, because the backend reads it at runtime', () => {
    expect(dockerfile).toMatch(/ARG APP_VERSION=""[\s\S]*?ENV APP_VERSION=\$APP_VERSION/);
  });

  /**
   * In `runner`, not `builder`: the value has to survive into the image the
   * deployment actually runs, and a build-stage ENV would not.
   */
  it('bakes it into the stage production runs', () => {
    const [, runner = ''] = dockerfile.split(/^FROM .* AS runner$/m);
    expect(runner).toMatch(/ENV APP_VERSION=\$APP_VERSION/);
  });
});
