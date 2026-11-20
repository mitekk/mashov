/**
 * **G2** — the stamped-school preference in the fallback, on real Postgres.
 *
 * `3afde47` (**R16**) made a foreign stamp count as no stamp, and the fallback
 * under it prefer the caller's own connection **at the stamped school** before
 * the generic `lastLoginAt desc` pick. That preference is what makes B3's
 * postcondition — "lands on the caller's connection at the same school" — true
 * in a two-school household rather than only in a one-school one.
 *
 * It had a unit case and no integration case: the three integration cases that
 * landed with R16 are one-school, so they would still pass with the preference
 * removed. The fixture here is the only shape that can fail without it — the
 * caller holds connections at TWO schools, and the more recently used one is
 * the wrong school.
 *
 * Its own seed and cleanup, deliberately not bolted onto
 * `household-isolation`: that file's `cleanup()` deletes connections by
 * `schoolCode: SEMEL` alone and would leave a second school's rows behind.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { ConnectionScopeService } from '../../backend/src/common/connection-scope/connection-scope.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { EncryptionService } from '../../backend/src/session/encryption.service';

/** Two schools, so "the caller's connection at the stamped school" has a wrong answer available. */
const SEMEL_A = 661101;
const SEMEL_B = 661102;
const SEMELS = [SEMEL_A, SEMEL_B];
const YEAR = 2027;

/** The caller: one household, one account per school. */
const CALLER = 'g2-caller';
/** The other parent at school A, sharing a child with the caller (ADR-0031). */
const OTHER = 'g2-other';
const ALL_USERS = [CALLER, OTHER];

const CALLER_AT_A = 'g2-conn-caller-a';
/** The caller's MOST RECENTLY USED connection, and at the wrong school. */
const CALLER_AT_B = 'g2-conn-caller-b';
const OTHER_AT_A = 'g2-conn-other-a';

const SHARED_CHILD = 'g2-guid-shared';
const UNSTAMPED_CHILD = 'g2-guid-unstamped';
const ALL_GUIDS = [SHARED_CHILD, UNSTAMPED_CHILD];

describe('The fallback prefers the caller’s connection at the stamped school', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    // Both school codes. Deleting by one of them is exactly the hazard that
    // kept this case out of `household-isolation`.
    await prisma.householdConnection.deleteMany({ where: { schoolCode: { in: SEMELS } } });
    await prisma.appUser.deleteMany({ where: { id: { in: ALL_USERS } } });
  }

  async function seed(): Promise<void> {
    await cleanup();

    for (const [id, semel] of [
      [CALLER, SEMEL_A],
      [OTHER, SEMEL_A],
    ] as Array<[string, number]>) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username: id,
          displayName: id,
          semel,
        },
      });
    }

    for (const [id, userId, schoolCode, lastLoginAt] of [
      // Older: the generic `lastLoginAt desc` pick would skip it, which is the
      // whole bug the preference closes.
      [CALLER_AT_A, CALLER, SEMEL_A, new Date('2026-11-01T08:00:00Z')],
      [CALLER_AT_B, CALLER, SEMEL_B, new Date('2026-11-19T08:00:00Z')],
      [OTHER_AT_A, OTHER, SEMEL_A, new Date('2026-11-20T08:00:00Z')],
    ] as Array<[string, string, number, Date]>) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username: id,
          schoolCode,
          schoolYear: YEAR,
          // Distinct per connection: "which credential was spent" is only
          // assertable if the credentials are telling apart at all.
          encryptedPassword: `enc-${id}`,
          schoolName: `בית ספר ${schoolCode}`,
          active: true,
          lastLoginAt,
        },
      });
    }

    const child = (studentGuid: string, stamp: string | null) => ({
      studentGuid,
      privateName: 'ילד',
      familyName: 'כלשהו',
      fullName: `ילד ${studentGuid}`,
      classCode: 'ז',
      classNum: 1,
      gender: 'M',
      isActive: true,
      householdConnectionId: stamp,
    });

    await prisma.student.createMany({
      data: [
        // Stamped to the OTHER parent at school A: the state that parent's
        // sync leaves behind, and correct — the child is theirs too.
        child(SHARED_CHILD, OTHER_AT_A),
        child(UNSTAMPED_CHILD, null),
      ],
    });

    // The caller sees both children by the visibility edge, so a refusal here
    // would be a bug of its own rather than the scoping working.
    await prisma.studentConnection.createMany({
      data: [
        { studentGuid: SHARED_CHILD, householdConnectionId: CALLER_AT_A, lastSeenInRosterAt: new Date() },
        { studentGuid: SHARED_CHILD, householdConnectionId: OTHER_AT_A, lastSeenInRosterAt: new Date() },
        { studentGuid: UNSTAMPED_CHILD, householdConnectionId: CALLER_AT_A, lastSeenInRosterAt: new Date() },
      ],
    });
  }

  function makeScope(): ConnectionScopeService {
    return new ConnectionScopeService(prisma as unknown as PrismaService, {
      decrypt: (value: string) => value,
    } as unknown as EncryptionService);
  }

  it('lands on the caller’s school-A connection, not their newer school-B one', async () => {
    const target = await makeScope().targetForStudent(SHARED_CHILD, CALLER);

    expect(target.id).toBe(CALLER_AT_A);
    expect(target.schoolCode).toBe(SEMEL_A);
    // The credential actually spent. Without the preference this is
    // `enc-${CALLER_AT_B}` — the caller's own password, so no cross-household
    // leak, but the wrong school's account, which Mashov answers with nothing.
    expect(target.password).toBe(`enc-${CALLER_AT_A}`);
  });

  it('never spends the other household’s credentials on the shared child', async () => {
    const target = await makeScope().targetForStudent(SHARED_CHILD, CALLER);

    // R16's own postcondition, re-asserted here because the two-school fixture
    // is the first place a wrong preference could satisfy it by accident.
    expect(target.id).not.toBe(OTHER_AT_A);
    expect(target.password).not.toBe(`enc-${OTHER_AT_A}`);
  });

  it('still honours the stamp for the household that owns it', async () => {
    const target = await makeScope().targetForStudent(SHARED_CHILD, OTHER);

    expect(target.id).toBe(OTHER_AT_A);
  });

  it('falls back to the most recently used connection when there is no stamp', async () => {
    // No stamp means no school to prefer, so the generic pick is correct and
    // must stay reachable: the preference narrows the stamped case only.
    const target = await makeScope().targetForStudent(UNSTAMPED_CHILD, CALLER);

    expect(target.id).toBe(CALLER_AT_B);
  });

  it('keeps the global fallback for a caller-less path', async () => {
    // The crons and the digest resolve with no caller. The stamp is
    // authoritative there, foreign or not — there is no household to scope to.
    const target = await makeScope().targetForStudent(SHARED_CHILD);

    expect(target.id).toBe(OTHER_AT_A);
  });
});
