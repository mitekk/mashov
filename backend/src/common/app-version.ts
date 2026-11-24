import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Candidate locations of the backend's own package.json.
 *
 * Two, because this file runs from two different depths: `src/common` under
 * ts-jest and `dist/src/common` in the image, where the Dockerfile copies
 * package.json to /app. Resolving by walking the tree would also find the
 * workspace root's package.json on a developer machine, which is a different
 * version -- so the candidates are explicit.
 */
const CANDIDATES = [
  join(__dirname, '..', '..', 'package.json'),
  join(__dirname, '..', '..', '..', 'package.json'),
];

function readPackageVersion(): string {
  for (const candidate of CANDIDATES) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      const version = (parsed as { name?: unknown; version?: unknown });
      // Name-checked so a neighbouring package.json cannot answer for us.
      if (version.name === 'mashov-backend' && typeof version.version === 'string') {
        return version.version;
      }
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return '';
}

/** The version declared in backend/package.json, or '' if it cannot be read. */
export const PACKAGE_VERSION = readPackageVersion();

/**
 * Which build this process is, for a feedback row to record.
 *
 * `APP_VERSION` first, so CI or ops can stamp a tag or a git sha onto a
 * deployment; the package.json version otherwise, so a stack with no
 * configuration at all still records something. `||`, not `??`: compose sets
 * `APP_VERSION: ${APP_VERSION:-}`, so an operator who set nothing hands this a
 * SET empty string rather than an absent one.
 *
 * Worth knowing: the package.json version in this repo has not changed since
 * the file was created, so on its own it cannot tell two builds apart. It is
 * a floor, not a release process.
 */
export function appVersion(): string | null {
  return process.env.APP_VERSION?.trim() || PACKAGE_VERSION || null;
}
