import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_FEEDBACK_DEFAULT_LIMIT,
  AdminFeedbackService,
} from './admin-feedback.service';

const ROW = {
  id: 'fb-1',
  subject: 'bug',
  subjectOther: null,
  contactEmail: 'parent@example.com',
  content: 'המערכת לא מציגה ציונים',
  pagePath: '/children/abc',
  userAgent: 'Mozilla/5.0',
  viewportWidth: 390,
  viewportHeight: 844,
  appVersion: '1.4.2',
  mashovUserId: 'mashov-1',
  username: 'parent-one',
  displayName: 'קורס דמיטרי',
  schoolsSnapshot: [
    { id: 'c1', schoolCode: 540175, schoolName: 'תיכון הרצוג', label: 'הרצוג', schoolYear: 2026 },
  ],
  createdAt: new Date('2026-11-28T08:30:00.000Z'),
  notifiedAt: new Date('2026-11-28T08:32:00.000Z'),
  notifyAttempts: 1,
  notifyError: null,
  readAt: null,
  respondedAt: null,
};

function build() {
  const findMany = jest.fn().mockResolvedValue([ROW]);
  const count = jest.fn().mockResolvedValue(1);
  const findUnique = jest.fn().mockResolvedValue(ROW);
  const update = jest.fn().mockImplementation(({ data }) => ({ ...ROW, ...data }));
  const prisma = {
    feedback: { findMany, count, findUnique, update },
  } as unknown as PrismaService;

  return { service: new AdminFeedbackService(prisma), findMany, count, findUnique, update };
}

describe('AdminFeedbackService', () => {
  describe('list', () => {
    it('returns the standard envelope with computed totalPages', async () => {
      const { service, count } = build();
      count.mockResolvedValue(43);

      const result = await service.list('all', 2, 20);

      expect(result.pagination).toEqual({ page: 2, limit: 20, total: 43, totalPages: 3 });
      expect(result.data).toHaveLength(1);
    });

    it('reports zero pages for an empty table rather than one empty page', async () => {
      const { service, count, findMany } = build();
      count.mockResolvedValue(0);
      findMany.mockResolvedValue([]);

      expect((await service.list('all', 1, 20)).pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('omits the report text from a list item, and keeps the three state flags', async () => {
      const { service } = build();

      const [item] = (await service.list('all', 1, 20)).data;

      expect(item).not.toHaveProperty('content');
      expect(item).toMatchObject({
        id: 'fb-1',
        subject: 'bug',
        subjectOther: null,
        displayName: 'קורס דמיטרי',
        username: 'parent-one',
        hasContactEmail: true,
        schools: ['הרצוג (540175)'],
        createdAt: '2026-11-28T08:30:00.000Z',
        notifiedAt: '2026-11-28T08:32:00.000Z',
        readAt: null,
        respondedAt: null,
      });
    });

    it('includes null state fields explicitly rather than omitting them', async () => {
      const { service } = build();
      const [item] = (await service.list('all', 1, 20)).data;
      expect(Object.keys(item)).toEqual(expect.arrayContaining(['readAt', 'respondedAt', 'notifiedAt']));
    });

    it('pages newest first with an offset', async () => {
      const { service, findMany } = build();

      await service.list('all', 3, 10);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 20, take: 10 }),
      );
    });

    describe('filter predicates', () => {
      it('filters nothing for "all"', async () => {
        const { service, findMany, count } = build();
        await service.list('all', 1, 20);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
        expect(count).toHaveBeenCalledWith({ where: {} });
      });

      it('"new" means nobody has opened it yet', async () => {
        const { service, findMany, count } = build();
        await service.list('new', 1, 20);
        expect(findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { readAt: null } }),
        );
        expect(count).toHaveBeenCalledWith({ where: { readAt: null } });
      });

      it('"awaiting" means a reply address with no reply sent', async () => {
        // A report with no contactEmail can never be answered, so it must not
        // sit in this list forever.
        const { service, findMany, count } = build();
        await service.list('awaiting', 1, 20);
        const where = { contactEmail: { not: null }, respondedAt: null };
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
        expect(count).toHaveBeenCalledWith({ where });
      });

      it('counts over the FILTERED set, so the totals match the page', async () => {
        const { service, count } = build();
        await service.list('new', 1, 20);
        expect(count).toHaveBeenCalledWith({ where: { readAt: null } });
      });
    });

    it('renders a school whose label is missing by its name, and an empty set as none', async () => {
      const { service, findMany } = build();
      findMany.mockResolvedValue([
        { ...ROW, schoolsSnapshot: [{ schoolCode: 1, schoolName: 'בית ספר', schoolYear: 2026 }] },
        { ...ROW, schoolsSnapshot: [] },
        // Json column: db push never validated it and a pre-feature row can
        // hold anything.
        { ...ROW, schoolsSnapshot: 'nonsense' },
      ]);

      const { data } = await service.list('all', 1, 20);

      expect(data[0].schools).toEqual(['בית ספר (1)']);
      expect(data[1].schools).toEqual([]);
      expect(data[2].schools).toEqual([]);
    });
  });

  describe('detail', () => {
    it('returns the whole row, including the delivery state', async () => {
      const { service } = build();

      const detail = await service.detail('fb-1');

      expect(detail).toMatchObject({
        id: 'fb-1',
        content: 'המערכת לא מציגה ציונים',
        contactEmail: 'parent@example.com',
        pagePath: '/children/abc',
        userAgent: 'Mozilla/5.0',
        viewportWidth: 390,
        viewportHeight: 844,
        appVersion: '1.4.2',
        mashovUserId: 'mashov-1',
        notifyAttempts: 1,
        notifyError: null,
      });
    });

    it('stamps readAt the first time it is opened', async () => {
      const { service, update } = build();

      const detail = await service.detail('fb-1');

      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: { readAt: expect.any(Date) },
      });
      expect(detail.readAt).not.toBeNull();
    });

    it('does not re-stamp readAt on a second open', async () => {
      const { service, findUnique, update } = build();
      findUnique.mockResolvedValue({ ...ROW, readAt: new Date('2026-11-28T09:00:00.000Z') });

      const detail = await service.detail('fb-1');

      expect(update).not.toHaveBeenCalled();
      expect(detail.readAt).toBe('2026-11-28T09:00:00.000Z');
    });

    it('404s for an id that does not exist', async () => {
      const { service, findUnique } = build();
      findUnique.mockResolvedValue(null);

      await expect(service.detail('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markResponded', () => {
    it('sets respondedAt and returns the updated detail', async () => {
      const { service, update } = build();

      const detail = await service.markResponded('fb-1');

      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: { respondedAt: expect.any(Date), readAt: expect.any(Date) },
      });
      expect(detail.respondedAt).not.toBeNull();
    });

    it('keeps the ORIGINAL respondedAt when called twice', async () => {
      // Idempotent on purpose: the value answers "when was this parent
      // answered", and a second click must not rewrite that to today.
      const { service, findUnique, update } = build();
      const answered = new Date('2026-11-28T09:00:00.000Z');
      findUnique.mockResolvedValue({ ...ROW, readAt: answered, respondedAt: answered });

      const detail = await service.markResponded('fb-1');

      expect(update).not.toHaveBeenCalled();
      expect(detail.respondedAt).toBe('2026-11-28T09:00:00.000Z');
    });

    it('404s for an id that does not exist', async () => {
      const { service, findUnique } = build();
      findUnique.mockResolvedValue(null);

      await expect(service.markResponded('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('names 20 as the default page size the contract promises', () => {
    expect(ADMIN_FEEDBACK_DEFAULT_LIMIT).toBe(20);
  });
});
