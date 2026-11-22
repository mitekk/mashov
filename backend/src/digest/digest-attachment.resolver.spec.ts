import { DigestAttachmentResolver } from './digest-attachment.resolver';
import type { PrismaService } from '../prisma/prisma.service';
import type { DigestCandidate } from './digest.types';

const GUID = 'stu-1';

function makeHarness(options: {
  homework?: Record<string, unknown>[];
  behavior?: Record<string, unknown>[];
} = {}) {
  const homeworkFindMany = jest.fn().mockResolvedValue(options.homework ?? []);
  const behaviorFindMany = jest.fn().mockResolvedValue(options.behavior ?? []);

  const prisma = {
    homeworkItem: { findMany: homeworkFindMany },
    behaviorItem: { findMany: behaviorFindMany },
  } as unknown as PrismaService;

  return {
    resolver: new DigestAttachmentResolver(prisma),
    homeworkFindMany,
    behaviorFindMany,
  };
}

function candidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return { itemType: 'homework_new', itemId: 'hw-1', contentHash: 'h', ...overrides };
}

describe('DigestAttachmentResolver', () => {
  it('reads a homework item’s files column', async () => {
    const harness = makeHarness({
      homework: [{ id: 'hw-1', files: [{ fileId: 'f1', fileName: 'דף עבודה.pdf' }] }],
    });

    const refs = await harness.resolver.resolve(GUID, [candidate()]);

    expect(refs).toEqual([
      {
        itemType: 'homework',
        itemId: 'hw-1',
        studentGuid: GUID,
        fileId: 'f1',
        fileName: 'דף עבודה.pdf',
      },
    ]);
  });

  it('reads a behavior item’s files out of rawPayload, which is the only place they are', async () => {
    const harness = makeHarness({
      behavior: [
        { id: 'beh-1', lessonId: 90, rawPayload: { files: [{ id: 'f2', name: 'מכתב.pdf' }] } },
      ],
    });

    const refs = await harness.resolver.resolve(GUID, [
      candidate({ itemType: 'behavior', itemId: 'beh-1' }),
    ]);

    expect(refs[0]).toMatchObject({ itemType: 'behavior', itemId: 'beh-1', fileId: 'f2' });
  });

  it('selects nothing but the id and the attachment columns', async () => {
    // The point of this class: `files` and `rawPayload` must NOT be added to
    // DigestPayload, which feeds buildPrompt and is the PII boundary. A
    // behaviour rawPayload carries the reporter's name and the child's guid.
    const harness = makeHarness({
      homework: [{ id: 'hw-1', files: [] }],
      behavior: [{ id: 'beh-1', lessonId: 90, rawPayload: {} }],
    });

    await harness.resolver.resolve(GUID, [
      candidate(),
      candidate({ itemType: 'behavior', itemId: 'beh-1' }),
    ]);

    expect(harness.homeworkFindMany.mock.calls[0][0].select).toEqual({ id: true, files: true });
    expect(harness.behaviorFindMany.mock.calls[0][0].select).toEqual({
      id: true,
      rawPayload: true,
      lessonId: true,
    });
  });

  it('scopes both reads to the child being reported', async () => {
    const harness = makeHarness({ homework: [], behavior: [] });

    await harness.resolver.resolve(GUID, [
      candidate(),
      candidate({ itemType: 'behavior', itemId: 'beh-1' }),
    ]);

    expect(harness.homeworkFindMany.mock.calls[0][0].where.studentGuid).toBe(GUID);
    expect(harness.behaviorFindMany.mock.calls[0][0].where.studentGuid).toBe(GUID);
  });

  it('asks for a homework row once when it was claimed twice', async () => {
    // The same row can be claimed as newly assigned AND as estimated-due.
    const harness = makeHarness({ homework: [{ id: 'hw-1', files: [] }] });

    await harness.resolver.resolve(GUID, [
      candidate({ itemType: 'homework_new' }),
      candidate({ itemType: 'homework_due' }),
    ]);

    expect(harness.homeworkFindMany).toHaveBeenCalledTimes(1);
    expect(harness.homeworkFindMany.mock.calls[0][0].where.id.in).toEqual(['hw-1']);
  });

  it('issues no query for a kind of candidate it was given none of', async () => {
    const harness = makeHarness();

    await harness.resolver.resolve(GUID, [candidate({ itemType: 'release', itemId: '7' })]);

    expect(harness.homeworkFindMany).not.toHaveBeenCalled();
    expect(harness.behaviorFindMany).not.toHaveBeenCalled();
  });

  it('returns nothing for an item with no attachments', async () => {
    const harness = makeHarness({ homework: [{ id: 'hw-1', files: [] }] });

    expect(await harness.resolver.resolve(GUID, [candidate()])).toEqual([]);
  });
});
