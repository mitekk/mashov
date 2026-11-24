/**
 * Tests for the test selector.
 *
 * The selector now decides whether anything gets tested at all, so it needs
 * its own coverage. Run with `node --test scripts/` -- NOT jest: the root jest
 * config's testRegex is scoped to tests/integration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, loadE2eMap } from './select-tests.mjs';

const e2eMap = loadE2eMap();
const BASE = 'a1b2c3d';

function run(changed, { deleted = [], commitMessage = 'feat: something' } = {}) {
  return decide({ changed, deleted, commitMessage, base: BASE, e2eMap });
}

test('docs-only change selects no layer', () => {
  const d = run(['docs/adr/0042-whatever.md', 'README.md', 'apis/get-api-schools.md']);
  assert.equal(d.full, false);
  assert.equal(d.vitest, false);
  assert.equal(d.unit, false);
  assert.equal(d.integration, false);
  assert.equal(d.e2e, false);
  assert.match(d.reason, /no test layer affected/);
});

test('a frontend page change selects vitest + e2e only, with auth.setup.ts first', () => {
  const d = run(['frontend/src/app/inbox/page.tsx']);
  assert.equal(d.full, false);
  assert.equal(d.vitest, true);
  assert.equal(d.e2e, true);
  assert.equal(d.unit, false);
  assert.equal(d.integration, false);

  const specs = d.playwright_args.split(' ');
  assert.equal(specs[0], 'auth.setup.ts', 'auth.setup.ts must be first');
  assert.ok(specs.includes('inbox.spec.ts'));
  assert.ok(specs.includes('home.spec.ts'));
  assert.ok(!specs.includes('children.spec.ts'));

  assert.equal(d.vitest_args, `--changed ${BASE} --passWithNoTests`);
  assert.equal(d.jest_args, '');
});

test('a shared frontend component change runs every spec on two shards', () => {
  const d = run(['frontend/src/components/layout/AppNav.tsx']);
  assert.equal(d.full, false);
  assert.equal(d.e2e, true);
  assert.equal(d.playwright_args, '', 'empty args means the whole Playwright suite');
  assert.equal(d.e2e_shards, '[1,2]');
  assert.equal(d.e2e_shard_total, 2);
});

test('a leaf backend change narrows unit to --findRelatedTests with backend-relative paths', () => {
  const d = run(['backend/src/digest/digest.service.ts']);
  assert.equal(d.full, false);
  assert.equal(d.unit, true);
  assert.equal(d.integration, true);
  assert.equal(d.vitest, false);

  // Paths must drop the `backend/` prefix: /app in the unit container IS backend/.
  assert.equal(
    d.jest_args,
    '--findRelatedTests src/digest/digest.service.ts --coverage=false --passWithNoTests',
  );
  assert.ok(!d.jest_args.includes('backend/'));

  // digest has no e2e coverage, so the e2e layer drops out entirely.
  assert.equal(d.e2e, false);

  // backend/** touched -> integration cannot be narrowed.
  assert.equal(d.integration_args, '');
});

test('a changed integration spec does not widen the e2e selection', () => {
  const d = run(['backend/src/auth/auth.service.ts', 'tests/integration/auth-recovery.test.ts']);
  assert.equal(d.full, false);
  assert.equal(d.e2e, true);
  assert.equal(
    d.playwright_args,
    'auth.setup.ts auth-recovery.spec.ts auth.spec.ts',
    'tests/integration/** is not an e2e area and must not hit the unmapped default',
  );
});

test('a backend auth change picks the two auth specs and a single shard', () => {
  const d = run(['backend/src/auth/auth.service.ts']);
  assert.equal(d.e2e, true);
  assert.equal(d.playwright_args, 'auth.setup.ts auth-recovery.spec.ts auth.spec.ts');
  assert.equal(d.e2e_shards, '[1]');
  assert.equal(d.e2e_shard_total, 1);
});

test('an integration-spec-only change narrows to those spec paths', () => {
  const d = run(['tests/integration/auth.test.ts', 'docs/notes.md']);
  assert.equal(d.full, false);
  assert.equal(d.integration, true);
  assert.equal(d.unit, false);
  assert.equal(d.e2e, false);
  assert.equal(d.integration_args, 'tests/integration/auth.test.ts');
});

test('an e2e-spec-only change runs just that spec plus setup', () => {
  const d = run(['tests/e2e/children.spec.ts']);
  assert.equal(d.e2e, true);
  assert.equal(d.unit, false);
  assert.equal(d.integration, false);
  assert.equal(d.playwright_args, 'auth.setup.ts children.spec.ts');
});

test('a page-object change runs every spec', () => {
  const d = run(['tests/e2e/pages/HomePage.ts']);
  assert.equal(d.e2e, true);
  assert.equal(d.playwright_args, '');
});

test('a lockfile change forces a full run', () => {
  const d = run(['backend/package-lock.json']);
  assert.equal(d.full, true);
  assert.equal(d.vitest, true);
  assert.equal(d.unit, true);
  assert.equal(d.integration, true);
  assert.equal(d.e2e, true);
  assert.equal(d.jest_args, '', 'a full run must not narrow');
  assert.equal(d.playwright_args, '');
  assert.equal(d.e2e_shards, '[1,2]');
  assert.match(d.reason, /full-run pattern/);
});

for (const [path, pattern] of [
  ['backend/prisma/schema.prisma', /backend\/prisma/],
  ['docker-compose.yml', /docker-compose/],
  ['.github/workflows/ci.yml', /workflows/],
  ['.github/e2e-map.json', /e2e-map/],
  ['playwright.config.ts', /playwright\.config/],
  ['scripts/select-tests.mjs', /scripts/],
  ['frontend/Dockerfile', /Dockerfile/],
  ['backend/tsconfig.json', /tsconfig/],
]) {
  test(`${path} forces a full run`, () => {
    const d = run([path]);
    assert.equal(d.full, true, `${path} should force a full run`);
    assert.match(d.reason, pattern);
  });
}

test('a path matching nothing forces a full run rather than silently skipping', () => {
  const d = run(['some-new-toplevel-thing/config.yaml']);
  assert.equal(d.full, true);
  assert.match(d.reason, /unrecognised path/);
});

test('[ci full] in a commit message forces a full run regardless of paths', () => {
  const d = run(['docs/readme-notes.md'], { commitMessage: 'docs: tweak\n\n[ci full]' });
  assert.equal(d.full, true);
  assert.equal(d.unit, true);
  assert.match(d.reason, /\[ci full\]/);
});

test('[ci full] is found anywhere in the range, not only in the newest commit', () => {
  // On a pull_request event HEAD is a synthetic merge commit, so the selector
  // scans every message in base..HEAD rather than just the tip.
  const message = [
    'Merge abc123 into def456',
    'fix: later work',
    'chore: force the estate [ci full]',
  ].join('\n\n');
  const d = run(['docs/x.md'], { commitMessage: message });
  assert.equal(d.full, true);
  assert.match(d.reason, /\[ci full\]/);
});

test('a deleted backend source file forces its layers to run unnarrowed', () => {
  const d = run(['backend/src/digest/digest.service.ts'], {
    deleted: ['backend/src/digest/old-sender.ts'],
  });
  assert.equal(d.full, false);
  assert.equal(d.unit, true);
  assert.equal(d.jest_args, '', 'nothing left on disk to trace from');
  assert.equal(d.e2e, true, 'a deleted file in an e2e layer cannot be narrowed');
  assert.equal(d.playwright_args, '');
});

test('a deleted frontend file un-narrows vitest', () => {
  const d = run(['frontend/src/app/inbox/page.tsx'], {
    deleted: ['frontend/src/app/inbox/Old.tsx'],
  });
  assert.equal(d.vitest, true);
  assert.equal(d.vitest_args, '');
});

test('a non-traceable backend file runs the whole unit layer', () => {
  const d = run(['backend/.eslintrc.js']);
  assert.equal(d.full, false);
  assert.equal(d.unit, true);
  assert.equal(d.jest_args, '');
});

test('a changed backend spec file resolves to itself', () => {
  const d = run(['backend/src/digest/digest.service.spec.ts']);
  assert.equal(
    d.jest_args,
    '--findRelatedTests src/digest/digest.service.spec.ts --coverage=false --passWithNoTests',
  );
});
