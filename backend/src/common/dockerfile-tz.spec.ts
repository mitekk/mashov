import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The zone pin is correctness-critical for mail read state (see process-zone.ts) and
 * trivially droppable in a Dockerfile edit, so it is asserted rather than trusted.
 *
 * Both stages matter: `runner` is production, and the `unit` compose service runs the
 * test suite from `builder`, so tests and production must agree on the zone.
 */
const DOCKERFILE = join(__dirname, '..', '..', 'Dockerfile');

describe('Dockerfile timezone pin', () => {
  const lines = readFileSync(DOCKERFILE, 'utf8').split('\n');

  it('pins TZ=UTC once per stage', () => {
    const stages = lines.filter((line) => /^FROM\s/.test(line));
    const pins = lines.filter((line) => /^ENV\s+TZ=UTC\s*$/.test(line.trim()));

    expect(stages).toHaveLength(2);
    expect(pins).toHaveLength(2);
  });

  it('pins the zone in every stage, not twice in one', () => {
    const perStage = lines.reduce<number[]>((counts, line) => {
      if (/^FROM\s/.test(line)) counts.push(0);
      if (/^ENV\s+TZ=UTC\s*$/.test(line.trim())) counts[counts.length - 1] += 1;
      return counts;
    }, []);

    expect(perStage).toEqual([1, 1]);
  });
});
