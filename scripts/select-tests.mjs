#!/usr/bin/env node
/**
 * PR-relevant test selection.
 *
 * Single source of truth for "which test layers does this diff actually need?",
 * shared by CI (the `changes` job) and the local loop (`npm run test:pr`).
 *
 * Reads a git diff, classifies the changed paths into the four test layers
 * (frontend vitest, backend jest unit, integration, Playwright e2e), narrows
 * within each layer where it safely can, and prints the decision as JSON. When
 * $GITHUB_OUTPUT is set it also writes the same fields as job outputs.
 *
 * Design notes that are load-bearing:
 *
 *  - Anything the map does not recognise forces a FULL run. A silent skip is a
 *    false negative that ships a bug; a needless full run only costs minutes.
 *    That is what stops this map rotting as the tree grows.
 *
 *  - `unit` uses jest `--findRelatedTests <files>`, never `--changedSince`. The
 *    `unit` compose service builds the `builder` target of backend/Dockerfile
 *    and runs with no repo bind mount, so git history is not reliably present
 *    in that container. An explicit file list needs no git at all.
 *
 *  - Those file paths are emitted WITHOUT the `backend/` prefix: inside the
 *    `unit` container /app is the backend directory, not the repo root.
 *
 *  - `auth.setup.ts` is always prepended to a narrowed Playwright filter list.
 *    Measured on Playwright 1.58: a positional filter of `inbox.spec.ts` alone
 *    DOES still run the `setup` project, because playwright.config.ts gives
 *    `chromium` `dependencies: ['setup']` and dependency projects are exempt
 *    from positional file filters. So the prepend is not currently load-bearing
 *    -- it is kept because the alternative is for every narrowed e2e run to
 *    depend on that exemption staying true across Playwright upgrades, and the
 *    failure mode if it ever changes is silent: an unwritten
 *    tests/e2e/.auth/session.json and every authenticated spec failing on a
 *    missing storage state. It costs one extra test on an auth-only selection
 *    (the `chromium-auth` project has no setup dependency).
 *
 * Usage:
 *   node scripts/select-tests.mjs                 # print JSON (+ GITHUB_OUTPUT)
 *   node scripts/select-tests.mjs --print         # human-readable dry run
 *   node scripts/select-tests.mjs --run           # run the selected layers
 *   node scripts/select-tests.mjs --base <ref> [--head <ref>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_MAP_PATH = join(REPO_ROOT, '.github', 'e2e-map.json');
const ALL_SPECS_SENTINEL = '*';

/** Narrowed e2e runs below this many specs are not worth a second shard. */
const SHARD_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Full-run triggers. Any changed path matching one of these, or `[ci full]` in
// the head commit message, runs the entire estate unnarrowed.
// ---------------------------------------------------------------------------
const FULL_RUN_PATTERNS = [
  '**/package.json',
  '**/package-lock.json',
  'docker-compose*.yml',
  '**/Dockerfile',
  '.github/workflows/**',
  '.github/e2e-map.json',
  '**/tsconfig*.json',
  'backend/prisma/**',
  'frontend/vitest.config.ts',
  'frontend/next.config.ts',
  'frontend/tailwind.config.ts',
  'frontend/postcss.config.js',
  'playwright.config.ts',
  // The selector and its own tests: a change here changes what gets selected,
  // so it must not get to narrow its own validation.
  'scripts/**',
];

// ---------------------------------------------------------------------------
// Layer mapping. First match wins. `[]` means "no test layer needs this".
// A path matching nothing at all is an error that forces a full run.
// ---------------------------------------------------------------------------
const LAYER_PATTERNS = [
  ['docs/**', []],
  ['apis/**', []],
  ['ops/**', []],
  ['.claude/**', []],
  ['**/*.md', []],
  ['README*', []],
  ['.gitignore', []],
  ['test-results/**', []],
  ['**/.env.example', []],
  ['backend/**', ['unit', 'integration', 'e2e']],
  ['frontend/**', ['vitest', 'e2e']],
  ['tests/integration/**', ['integration']],
  ['tests/e2e/**', ['e2e']],
  ['tests/**', ['integration', 'e2e']],
];

// ---------------------------------------------------------------------------
// Glob matching: supports `**` (any path segments), `*` (within one segment).
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?'; // `**/` also matches zero directories
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

const globCache = new Map();
function matchesGlob(path, glob) {
  if (!globCache.has(glob)) globCache.set(glob, globToRegExp(glob));
  return globCache.get(glob).test(path);
}

/** Higher = more specific. Used to pick one winning e2e-map key per path. */
function specificity(glob) {
  return glob.replace(/\*/g, '').length - glob.split('*').length;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------
function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${err.message}`);
  }
}

function isCommit(ref) {
  if (!ref) return false;
  // An all-zero sha is what GitHub sends for a branch's first push.
  if (/^0{7,40}$/.test(ref)) return false;
  return git(['cat-file', '-e', `${ref}^{commit}`], { allowFailure: true }) !== null;
}

function resolveBase(explicitBase, head) {
  if (explicitBase) {
    return { base: explicitBase, baseSource: '--base flag' };
  }

  const eventName = process.env.GITHUB_EVENT_NAME;

  if (eventName === 'pull_request' && process.env.GITHUB_BASE_REF) {
    const remoteBase = `origin/${process.env.GITHUB_BASE_REF}`;
    if (isCommit(remoteBase)) {
      const mergeBase = git(['merge-base', remoteBase, head], { allowFailure: true });
      return {
        base: mergeBase || remoteBase,
        baseSource: mergeBase ? `merge-base with ${remoteBase}` : remoteBase,
      };
    }
  }

  if (eventName === 'push') {
    const before = process.env.GITHUB_EVENT_BEFORE;
    if (isCommit(before)) return { base: before, baseSource: 'GITHUB_EVENT_BEFORE' };
    return { base: `${head}~1`, baseSource: 'HEAD~1 (no usable event before-sha)' };
  }

  const mergeBase = git(['merge-base', head, 'origin/master'], { allowFailure: true });
  if (mergeBase) return { base: mergeBase, baseSource: 'merge-base with origin/master' };

  return { base: `${head}~1`, baseSource: 'HEAD~1 (no origin/master)' };
}

function diffNames(base, head, filter) {
  const out = git(['diff', '--name-only', `--diff-filter=${filter}`, `${base}...${head}`], {
    allowFailure: true,
  });
  if (out === null) {
    // No common ancestor (shallow clone, unrelated histories). Fall back to a
    // two-dot diff rather than silently selecting nothing.
    const fallback = git(['diff', '--name-only', `--diff-filter=${filter}`, base, head]);
    return fallback ? fallback.split('\n') : [];
  }
  return out ? out.split('\n') : [];
}

/** Uncommitted tracked edits plus untracked files (local runs only). */
function worktreeChanges() {
  const tracked = git(['diff', '--name-only', '--diff-filter=d', 'HEAD'], { allowFailure: true });
  const untracked = git(['ls-files', '--others', '--exclude-standard'], { allowFailure: true });
  return [...(tracked ? tracked.split('\n') : []), ...(untracked ? untracked.split('\n') : [])];
}

function worktreeDeletions() {
  const out = git(['diff', '--name-only', '--diff-filter=D', 'HEAD'], { allowFailure: true });
  return out ? out.split('\n') : [];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function layersFor(path) {
  for (const [glob, layers] of LAYER_PATTERNS) {
    if (matchesGlob(path, glob)) return layers;
  }
  return null; // unrecognised -> caller forces a full run
}

export function loadE2eMap() {
  const raw = JSON.parse(readFileSync(E2E_MAP_PATH, 'utf8'));
  return Object.entries(raw)
    .filter(([key]) => key !== '//')
    .sort((a, b) => specificity(b[0]) - specificity(a[0]));
}

/** Specs for one changed path: ALL_SPECS_SENTINEL, or an array of spec files. */
function e2eSpecsFor(path, e2eMap) {
  // A changed spec selects itself; the setup file and shared helpers are in the
  // map and resolve to "*" there.
  if (/^tests\/e2e\/[^/]+\.spec\.ts$/.test(path)) {
    return [path.slice('tests/e2e/'.length)];
  }
  for (const [glob, specs] of e2eMap) {
    if (matchesGlob(path, glob)) {
      return specs === ALL_SPECS_SENTINEL ? ALL_SPECS_SENTINEL : specs;
    }
  }
  // In the e2e layer but unmapped: over-run rather than under-run.
  return ALL_SPECS_SENTINEL;
}

/**
 * @param {{changed: string[], deleted: string[], commitMessage: string,
 *          base: string, e2eMap: [string, string|string[]][]}} input
 */
export function decide({ changed, deleted, commitMessage, base, e2eMap }) {
  const fullReasons = [];

  if (/\[ci full\]/i.test(commitMessage ?? '')) {
    fullReasons.push('[ci full] in a commit message in range');
  }

  const allPaths = [...changed, ...deleted];
  const forcedFull = new Set();
  for (const path of allPaths) {
    const hit = FULL_RUN_PATTERNS.find((glob) => matchesGlob(path, glob));
    if (hit) {
      forcedFull.add(path);
      fullReasons.push(`${path} matches full-run pattern ${hit}`);
    }
  }

  // Only paths that did NOT already force a full run need a layer: a root
  // config file legitimately belongs to no single layer.
  const unknown = allPaths.filter(
    (path) => !forcedFull.has(path) && layersFor(path) === null,
  );
  if (unknown.length) {
    fullReasons.push(`unrecognised path(s): ${unknown.slice(0, 5).join(', ')}`);
  }

  if (fullReasons.length) {
    return {
      full: true,
      reason: fullReasons[0],
      reasons: fullReasons,
      base,
      changed_count: changed.length,
      vitest: true,
      unit: true,
      integration: true,
      e2e: true,
      vitest_args: '',
      jest_args: '',
      integration_args: '',
      playwright_args: '',
      e2e_shards: '[1,2]',
      e2e_shard_total: 2,
    };
  }

  const active = new Set();
  // A deleted source file forces its whole layer to run unnarrowed: there is
  // nothing left on disk to trace the dependency graph from.
  const noNarrow = new Set();

  for (const path of changed) {
    for (const layer of layersFor(path)) active.add(layer);
  }
  for (const path of deleted) {
    for (const layer of layersFor(path)) {
      active.add(layer);
      noNarrow.add(layer);
    }
  }

  // --- unit: jest --findRelatedTests, paths relative to backend/ ----------
  let jestArgs = '';
  if (active.has('unit')) {
    const traceable = changed
      .filter((p) => /^backend\/(src|test)\/.+\.ts$/.test(p))
      .map((p) => p.slice('backend/'.length));
    const untraceable = changed.some(
      (p) => p.startsWith('backend/') && !/^backend\/(src|test)\/.+\.ts$/.test(p),
    );
    if (noNarrow.has('unit') || untraceable || traceable.length === 0) {
      jestArgs = '';
    } else {
      // --coverage=false because backend/package.json sets
      // coverageThreshold.global.lines: 80, which a subset run cannot clear.
      jestArgs = `--findRelatedTests ${traceable.join(' ')} --coverage=false --passWithNoTests`;
    }
  }

  // --- vitest: runs on the host in the lint job, so git IS available ------
  let vitestArgs = '';
  if (active.has('vitest') && !noNarrow.has('vitest')) {
    vitestArgs = `--changed ${base} --passWithNoTests`;
  }

  // --- integration: narrow only when nothing outside tests/integration ----
  let integrationArgs = '';
  if (active.has('integration')) {
    const onlyIntegrationSpecs =
      !noNarrow.has('integration') &&
      changed.every((p) => p.startsWith('tests/integration/') || layersFor(p).length === 0);
    if (onlyIntegrationSpecs) {
      const files = changed.filter((p) => /^tests\/integration\/.+\.test\.ts$/.test(p));
      if (files.length) integrationArgs = files.join(' ');
    }
  }

  // --- e2e: hand-maintained map -------------------------------------------
  let playwrightArgs = '';
  let specCount = Infinity;
  if (active.has('e2e')) {
    let all = noNarrow.has('e2e');
    const specs = new Set();
    for (const path of changed) {
      // Only consult the map for paths that actually reach the e2e layer. A
      // changed integration spec, for instance, is in `changed` but belongs to
      // no e2e area -- looking it up would hit the unmapped default and
      // needlessly widen the run to every spec.
      if (!layersFor(path).includes('e2e')) continue;
      const mapped = e2eSpecsFor(path, e2eMap);
      if (mapped === ALL_SPECS_SENTINEL) {
        all = true;
        break;
      }
      for (const spec of mapped) specs.add(spec);
    }
    if (all) {
      playwrightArgs = '';
    } else if (specs.size === 0) {
      active.delete('e2e'); // mapped areas have no e2e coverage at all
    } else {
      specCount = specs.size;
      playwrightArgs = ['auth.setup.ts', ...[...specs].sort()].join(' ');
    }
  }

  const shardTotal = active.has('e2e') && specCount <= SHARD_THRESHOLD ? 1 : 2;
  const touched = [...active];

  return {
    full: false,
    reason: touched.length
      ? `selected layers: ${touched.sort().join(', ')}`
      : 'no test layer affected by this diff',
    reasons: [],
    base,
    changed_count: changed.length,
    vitest: active.has('vitest'),
    unit: active.has('unit'),
    integration: active.has('integration'),
    e2e: active.has('e2e'),
    vitest_args: vitestArgs,
    jest_args: jestArgs,
    integration_args: integrationArgs,
    playwright_args: playwrightArgs,
    e2e_shards: shardTotal === 1 ? '[1]' : '[1,2]',
    e2e_shard_total: shardTotal,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { base: null, head: 'HEAD', print: false, run: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--head') opts.head = argv[++i];
    else if (arg === '--print' || arg === '--dry-run') opts.print = true;
    else if (arg === '--run') opts.run = true;
    else if (arg === '--json') opts.print = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const OUTPUT_KEYS = [
  'full',
  'reason',
  'base',
  'vitest',
  'unit',
  'integration',
  'e2e',
  'vitest_args',
  'jest_args',
  'integration_args',
  'playwright_args',
  'e2e_shards',
  'e2e_shard_total',
];

function writeGithubOutput(decision) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = OUTPUT_KEYS.map((key) => `${key}=${decision[key]}`);
  appendFileSync(file, `${lines.join('\n')}\n`);
}

function printHuman(decision, { baseSource, changed, deleted }) {
  const layers = ['vitest', 'unit', 'integration', 'e2e'];
  console.log('');
  console.log(`base ref        ${decision.base}  (${baseSource})`);
  console.log(`changed files   ${changed.length}${deleted.length ? ` (+${deleted.length} deleted)` : ''}`);
  console.log(`full run        ${decision.full ? 'YES' : 'no'}`);
  console.log(`reason          ${decision.reason}`);
  if (decision.reasons?.length > 1) {
    for (const extra of decision.reasons.slice(1)) console.log(`                ${extra}`);
  }
  console.log('');
  for (const layer of layers) {
    const on = decision[layer];
    const args = decision[`${layer === 'unit' ? 'jest' : layer === 'e2e' ? 'playwright' : layer}_args`];
    console.log(
      `  ${on ? '✔' : '·'} ${layer.padEnd(12)} ${on ? args || '(whole layer)' : 'skipped'}`,
    );
  }
  if (decision.e2e) console.log(`  shards: ${decision.e2e_shards}`);
  console.log('');
  if (changed.length && changed.length <= 40) {
    for (const path of changed) console.log(`    ${path}`);
    console.log('');
  }
}

function runLayer(name, command, args, env) {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n${name} FAILED (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function runSelected(decision) {
  const ran = [];
  if (decision.vitest) {
    ran.push('vitest');
    runLayer(
      'frontend vitest',
      'npm',
      ['--prefix', 'frontend', 'test', '--', ...decision.vitest_args.split(' ').filter(Boolean)],
      {},
    );
  }
  if (decision.unit) {
    ran.push('unit');
    runLayer('backend unit (docker)', 'npm', ['run', 'test:unit'], {
      JEST_ARGS: decision.jest_args,
    });
  }
  if (decision.integration) {
    ran.push('integration');
    runLayer('integration (docker)', 'npm', ['run', 'test:integration'], {
      INTEGRATION_ARGS: decision.integration_args,
    });
  }
  if (decision.e2e) {
    ran.push('e2e');
    runLayer('e2e (docker + playwright)', 'npm', ['run', 'test:e2e'], {
      PLAYWRIGHT_ARGS: decision.playwright_args,
    });
  }
  console.log(ran.length ? `\nAll selected layers passed: ${ran.join(', ')}` : '\nNothing to run.');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(E2E_MAP_PATH)) {
    throw new Error(`missing ${E2E_MAP_PATH}`);
  }

  const head = opts.head;
  const { base, baseSource } = resolveBase(opts.base, head);
  const changed = new Set(diffNames(base, head, 'd'));
  const deleted = new Set(diffNames(base, head, 'D'));

  // Locally, uncommitted work is the whole point of `npm run test:pr` -- a
  // developer running it before committing must not be told that nothing
  // changed. In CI the committed range is the whole truth, so leave it alone.
  if (!process.env.GITHUB_ACTIONS && opts.head === 'HEAD') {
    for (const path of worktreeChanges()) changed.add(path);
    for (const path of worktreeDeletions()) {
      deleted.add(path);
      changed.delete(path);
    }
  }

  // Every commit message in the range, not just HEAD's. On a pull_request event
  // HEAD is the synthetic merge commit, whose message is "Merge <sha> into
  // <sha>" -- reading only that would make `[ci full]` silently never fire on a
  // PR, which is the one place it matters. Scanning the range also means the
  // flag keeps applying for the rest of the branch once a commit carries it.
  const commitMessage =
    git(['log', '--pretty=%B', `${base}..${head}`], { allowFailure: true }) ??
    git(['log', '-1', '--pretty=%B', head], { allowFailure: true }) ??
    '';

  const changedList = [...changed];
  const deletedList = [...deleted];
  const decision = decide({
    changed: changedList,
    deleted: deletedList,
    commitMessage,
    base,
    e2eMap: loadE2eMap(),
  });

  writeGithubOutput(decision);

  if (opts.print || opts.run) {
    printHuman(decision, { baseSource, changed: changedList, deleted: deletedList });
  } else {
    console.log(JSON.stringify(decision, null, 2));
  }

  if (opts.run) runSelected(decision);
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (invokedDirectly) {
  main();
}
