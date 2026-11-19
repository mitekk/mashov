import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, CanceledError } from 'axios';
import { ConnectionService } from './connection.service';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { MashovSessionService } from '../session/mashov-session.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ConnectionService talks to Mashov through createMashovAxios(), so the
// assertions target the axios *instance* rather than the module-level helpers.
const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

const mockPrisma = {
  householdConnection: {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    delete: jest.fn(),
  },
  student: {
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn(),
  },
  // The visibility edge. `findMany` answers two questions here: which children
  // this connection lists, and which of those any OTHER connection also lists.
  studentConnection: {
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn(),
  },
  syncRun: { deleteMany: jest.fn() },
  homeworkItem: { deleteMany: jest.fn() },
  behaviorItem: { deleteMany: jest.fn() },
  messageBoardItem: { deleteMany: jest.fn() },
  timetableEntry: { deleteMany: jest.fn() },
  mailMessage: { deleteMany: jest.fn() },
  mailConversation: {
    // The unlink pre-reads this connection's conversation ids so it can delete
    // their messages regardless of how those messages are stamped.
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn(),
  },
  notificationEvent: { deleteMany: jest.fn() },
  // Both were missing from the old transaction entirely.
  studentRelease: { deleteMany: jest.fn() },
  schoolActivity: { deleteMany: jest.fn() },
  parentProfile: { deleteMany: jest.fn() },
  behaviorTypeReference: { deleteMany: jest.fn() },
  // All three digest tables are keyed by studentGuid and were also missing.
  digestRecipient: { deleteMany: jest.fn() },
  digestReportedItem: { deleteMany: jest.fn() },
  digestDelivery: { deleteMany: jest.fn() },
  subjectEnrollment: { deleteMany: jest.fn() },
  $transaction: jest.fn().mockResolvedValue([]),
};

const mockEncryption = {
  encrypt: jest.fn().mockReturnValue('enc-pw'),
  decrypt: jest.fn().mockReturnValue('plain-pw'),
};

const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

const mockSchoolYearService = {
  resolveForSchool: jest.fn(),
  reconcileFromLogin: jest.fn(),
  invalidate: jest.fn(),
};

/**
 * Unlink has to evict the connection's cached upstream cookies. There was no
 * eviction anywhere, so they lived in process memory until a restart.
 */
const mockSessionService = {
  invalidateConnection: jest.fn(),
};

describe('ConnectionService', () => {
  let service: ConnectionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    mockSchoolYearService.resolveForSchool.mockResolvedValue({
      year: 2027,
      source: 'calendar',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchoolYearService, useValue: mockSchoolYearService },
        { provide: MashovSessionService, useValue: mockSessionService },
      ],
    }).compile();

    service = module.get<ConnectionService>(ConnectionService);
  });

  describe('updateConnection', () => {
    const existingConn = {
      id: 'conn-1',
      userId: 'user-1',
      schoolCode: 482273,
      schoolYear: 2027,
      username: 'olduser',
      encryptedPassword: 'enc-old',
    };

    it("validates against the connection's own school year, not an env constant", async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      mockHttp.post.mockResolvedValue({ data: { credential: { userId: 'u' } }, headers: {} });

      await service.updateConnection('user-1', 'newuser', 'newpass');

      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2027 }),
        expect.anything(),
      );
      expect(mockSchoolYearService.resolveForSchool).not.toHaveBeenCalled();
    });

    it('resolves the year when the connection carries none', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue({
        ...existingConn,
        schoolYear: 0,
      });
      mockHttp.post.mockResolvedValue({ data: { credential: { userId: 'u' } }, headers: {} });

      await service.updateConnection('user-1', 'newuser', 'newpass');

      expect(mockSchoolYearService.resolveForSchool).toHaveBeenCalledWith(482273);
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2027 }),
        expect.anything(),
      );
    });

    it('throws 404 when no active connection found', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      await expect(service.updateConnection('user-1', 'newuser')).rejects.toThrow(NotFoundException);
    });

    it('validates new credentials and updates connection', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      mockHttp.post = jest.fn().mockResolvedValue({ data: {} });
      mockPrisma.householdConnection.update.mockResolvedValue({});

      const result = await service.updateConnection('user-1', 'newuser', 'newpass');

      expect(result).toEqual({ ok: true });
      expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'newuser' }),
        }),
      );
    });

    it('uses existing password when none provided', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      mockHttp.post = jest.fn().mockResolvedValue({ data: {} });
      mockPrisma.householdConnection.update.mockResolvedValue({});

      await service.updateConnection('user-1', 'newuser');

      expect(mockEncryption.decrypt).toHaveBeenCalledWith('enc-old');
    });

    it('throws 400 when Mashov rejects new credentials', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
      mockHttp.post = jest.fn().mockRejectedValue(new Error('401'));

      await expect(service.updateConnection('user-1', 'newuser', 'badpass')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 502, not 400, when the validation request is aborted', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      jest.spyOn(axios, 'isCancel').mockReturnValue(true);
      mockHttp.post = jest.fn().mockRejectedValue(new CanceledError('canceled'));

      await expect(
        service.updateConnection('user-1', 'newuser', 'badpass'),
      ).rejects.toThrow(BadGatewayException);
    });

    it('throws 502, not 400, when Mashov never responds', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(existingConn);
      jest.spyOn(axios, 'isCancel').mockReturnValue(false);
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockHttp.post = jest
        .fn()
        .mockRejectedValue(new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'));

      await expect(
        service.updateConnection('user-1', 'newuser', 'badpass'),
      ).rejects.toThrow(BadGatewayException);
    });
  });

  describe('deleteConnection', () => {
    const CONN_A = { id: 'conn-a', schoolCode: 540175 };
    const CONN_B = { id: 'conn-b', schoolCode: 999999 };

    /** Which model each deleteMany in the transaction was aimed at. */
    function deletedWheres(): Array<{ model: string; where: unknown }> {
      // The service passes an array of prepared Prisma promises to
      // $transaction. Each mocked deleteMany records its own argument, so the
      // intent is read back off the mocks rather than off the array.
      const models: Array<[string, jest.Mock]> = [
        ['mailMessage', mockPrisma.mailMessage.deleteMany],
        ['mailConversation', mockPrisma.mailConversation.deleteMany],
        ['notificationEvent', mockPrisma.notificationEvent.deleteMany],
        ['schoolActivity', mockPrisma.schoolActivity.deleteMany],
        ['parentProfile', mockPrisma.parentProfile.deleteMany],
        ['homeworkItem', mockPrisma.homeworkItem.deleteMany],
        ['behaviorItem', mockPrisma.behaviorItem.deleteMany],
        ['messageBoardItem', mockPrisma.messageBoardItem.deleteMany],
        ['timetableEntry', mockPrisma.timetableEntry.deleteMany],
        ['subjectEnrollment', mockPrisma.subjectEnrollment.deleteMany],
        ['studentRelease', mockPrisma.studentRelease.deleteMany],
        ['digestRecipient', mockPrisma.digestRecipient.deleteMany],
        ['digestReportedItem', mockPrisma.digestReportedItem.deleteMany],
        ['digestDelivery', mockPrisma.digestDelivery.deleteMany],
        ['behaviorTypeReference', mockPrisma.behaviorTypeReference.deleteMany],
        ['syncRun', mockPrisma.syncRun.deleteMany],
        ['studentConnection', mockPrisma.studentConnection.deleteMany],
        ['student', mockPrisma.student.deleteMany],
      ];
      return models.flatMap(([model, mock]) =>
        mock.mock.calls.map((call) => ({ model, where: call[0]?.where })),
      );
    }

    it('throws 404 when no connection found', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([]);
      await expect(service.deleteConnection('user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws 404 for a school this household does not have', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([]);
      await expect(service.deleteConnection('user-1', 'conn-elsewhere')).rejects.toThrow(
        NotFoundException,
      );
    });

    it("deletes only the unlinked school's data when another school remains", async () => {
      // The bug this replaces: the old version ran
      // mailConversation.deleteMany({}), mailMessage.deleteMany({}) and
      // notificationEvent.deleteMany({}) with no `where` at all, so unlinking
      // one school wiped the other's mail and notifications.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1); // conn-b remains
      mockPrisma.studentConnection.findMany
        .mockResolvedValueOnce([{ studentGuid: 'guid-a' }])
        .mockResolvedValueOnce([]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      for (const { model, where } of deletedWheres()) {
        expect(where).toBeDefined();
        expect(where).not.toEqual({});
        if (model === 'mailConversation') {
          expect(where).toEqual({ householdConnectionId: 'conn-a' });
        }
        if (model === 'mailMessage') {
          // Scoped by this connection's conversations OR its own stamp --
          // never unscoped, and never another school's conversation.
          expect(where).toEqual({
            OR: [
              { conversation: { householdConnectionId: 'conn-a' } },
              { householdConnectionId: 'conn-a' },
            ],
          });
        }
      }
    });

    it("reads the school's own children, not every active student", async () => {
      // `student.findMany({ isActive: true })` was the other half of the bug:
      // it enumerated every child in the database and then deleted their data.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      // Read from the visibility edge, not the routing stamp: a child this
      // school lists can carry the other parent's stamp (ADR-0031).
      expect(mockPrisma.studentConnection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { householdConnectionId: 'conn-a' } }),
      );
    });

    it('keeps a child the other parent still lists, and all of their data', async () => {
      // The blast radius ADR-0031 called out. Two parents, their own Mashov
      // accounts, the same children: unlinking one parent's school must remove
      // that parent's VIEW, not the child. Deleting the shared child would
      // take the other parent's homework, behaviour, releases and digest
      // history with it, unrecoverably.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.studentConnection.findMany
        // this connection lists both children...
        .mockResolvedValueOnce([{ studentGuid: 'guid-own' }, { studentGuid: 'guid-shared' }])
        // ...and another connection also lists the second one.
        .mockResolvedValueOnce([{ studentGuid: 'guid-shared' }]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      // Only the exclusively-listed child is deleted, everywhere.
      expect(mockPrisma.student.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['guid-own'] } },
      });
      for (const { model, where } of deletedWheres()) {
        const guids = (where as { studentGuid?: { in?: string[] } } | undefined)?.studentGuid
          ?.in;
        if (guids) {
          expect(guids).toEqual(['guid-own']);
          expect(model).not.toBe('__never__');
        }
      }
    });

    it('revokes the unlinked connection\'s view of a shared child', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.studentConnection.findMany
        .mockResolvedValueOnce([{ studentGuid: 'guid-shared' }])
        .mockResolvedValueOnce([{ studentGuid: 'guid-shared' }]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.studentConnection.deleteMany).toHaveBeenCalledWith({
        where: { householdConnectionId: 'conn-a' },
      });
      // ...and the child itself survives.
      expect(mockPrisma.student.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: [] } },
      });
    });

    it('deletes mail messages before mail conversations', async () => {
      // MailMessage.conversationId is a foreign key onto
      // MailConversation.conversationId, so the other order is a constraint
      // violation that rolls the whole unlink back.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      // invocationCallOrder, not the array's indexOf: the mocked deleteMany
      // calls all return undefined, so identity in the array cannot
      // distinguish them. The array is built in call order, so the order the
      // mocks were invoked in IS the order Prisma receives.
      const messageCall = mockPrisma.mailMessage.deleteMany.mock.invocationCallOrder[0];
      const conversationCall =
        mockPrisma.mailConversation.deleteMany.mock.invocationCallOrder[0];
      expect(messageCall).toBeLessThan(conversationCall);
    });

    it("deletes the connection's conversations' messages however they are stamped", async () => {
      // R2: the detail fetch wrote mailMessage rows with no
      // householdConnectionId, so a stamp predicate left them behind and
      // mailConversation.deleteMany then violated
      // mail_message_conversationId_fkey -- the same 500 on every retry. The
      // delete reaches them through the conversation instead.
      //
      // A relation filter, not a pre-read of conversation ids: the ids are
      // unbounded (nothing ever deletes a mail row), so an `in` list would
      // reintroduce exactly this failure class past Postgres's 16-bit
      // bind-parameter limit, and a read outside the transaction can miss a
      // conversation written after it.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.mailConversation.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.mailMessage.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { conversation: { householdConnectionId: 'conn-a' } },
            { householdConnectionId: 'conn-a' },
          ],
        },
      });
      // Still before the conversations, which is what the FK requires.
      expect(mockPrisma.mailMessage.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.mailConversation.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('unlinks every school in ONE transaction', async () => {
      // The old loop ran one $transaction per school, so a failure on the
      // second left the first unlinked and still returned a 500: the parent
      // pressed "disconnect all", got an error, and had no way to know half of
      // it had happened.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      await expect(service.deleteConnection('user-1')).resolves.toEqual({ ok: true });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Both schools' work is in it.
      const wheres = deletedWheres().map(({ where }) => JSON.stringify(where));
      expect(wheres.some((w) => w.includes('conn-a'))).toBe(true);
      expect(wheres.some((w) => w.includes('conn-b'))).toBe(true);
      // And both sessions are evicted, which only happens after the commit.
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-a');
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-b');
    });

    it('treats a child only ANOTHER surviving school lists as shared', async () => {
      // One transaction means the exclusion sets cannot be "every connection
      // but this one" any more. The sequential loop got this right by
      // accident: on the second school, the first school's links were already
      // deleted. Read up front, a child both unlinked schools list would look
      // shared to each of them and survive as an orphan with isActive: true --
      // the bug the student.deleteMany in here exists to prevent.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      // Both schools list the child; nothing outside the unlink does. Keyed on
      // the predicate rather than on call order, because both reads happen
      // twice over -- once per school.
      mockPrisma.studentConnection.findMany.mockImplementation(
        ({ where }: { where: { householdConnectionId?: { notIn?: string[] } } }) =>
          Promise.resolve(
            where.householdConnectionId?.notIn ? [] : [{ studentGuid: 'guid-shared' }],
          ),
      );
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1');

      // The "also listed elsewhere" read excludes BOTH schools being unlinked.
      expect(mockPrisma.studentConnection.findMany).toHaveBeenCalledWith({
        where: {
          studentGuid: { in: ['guid-shared'] },
          householdConnectionId: { notIn: ['conn-a', 'conn-b'] },
        },
        select: { studentGuid: true },
      });
      // Nothing else lists the child, so the child goes.
      expect(mockPrisma.student.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['guid-shared'] } },
      });
    });

    it('keeps the behaviour taxonomy only for a school that SURVIVES', async () => {
      // Same correction, on schoolCode: two connections at one school, both
      // being unlinked, must not each see the other as a reason to keep it.
      mockPrisma.householdConnection.findMany.mockResolvedValue([
        CONN_A,
        { id: 'conn-a2', schoolCode: CONN_A.schoolCode },
      ]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1');

      expect(mockPrisma.householdConnection.count).toHaveBeenCalledWith({
        where: {
          schoolCode: CONN_A.schoolCode,
          active: true,
          id: { notIn: ['conn-a', 'conn-a2'] },
        },
      });
    });

    it('now deletes studentRelease and schoolActivity', async () => {
      // Both were missing from the transaction entirely, so a parent's
      // early-release requests and consent answers survived an unlink and
      // reappeared on re-link.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.studentConnection.findMany
        .mockResolvedValueOnce([{ studentGuid: 'guid-a' }])
        .mockResolvedValueOnce([]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.studentRelease.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['guid-a'] } },
      });
      expect(mockPrisma.schoolActivity.deleteMany).toHaveBeenCalledWith({
        where: { householdConnectionId: 'conn-a' },
      });
    });

    it('deletes the digest subscriptions and the dedup ledger', async () => {
      // All three digest tables are keyed by studentGuid and survived an
      // unlink. Left behind, a re-link resurrects the subscriptions AND the
      // DigestReportedItem rows -- so the first digest after re-linking
      // silently suppresses every item it had already reported for a child
      // who no longer existed.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.studentConnection.findMany
        .mockResolvedValueOnce([{ studentGuid: 'guid-a' }])
        .mockResolvedValueOnce([]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      for (const mock of [
        mockPrisma.digestRecipient.deleteMany,
        mockPrisma.digestReportedItem.deleteMany,
        mockPrisma.digestDelivery.deleteMany,
      ]) {
        expect(mock).toHaveBeenCalledWith({ where: { studentGuid: { in: ['guid-a'] } } });
      }
    });

    it('deletes the student rows rather than orphaning them', async () => {
      // They used to survive with isActive: true, so the REMAINING school's
      // per-student crons 403'd on every one of them every twelve minutes,
      // forever.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.studentConnection.findMany
        .mockResolvedValueOnce([{ studentGuid: 'guid-a' }])
        .mockResolvedValueOnce([]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.student.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['guid-a'] } },
      });
    });

    it('keeps the behaviour taxonomy when another account shares the school', async () => {
      // Two parents at one school share it, and it is keyed by schoolCode.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.behaviorTypeReference.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the behaviour taxonomy when no other account is at that school', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.behaviorTypeReference.deleteMany).toHaveBeenCalledWith({
        where: { schoolCode: 540175 },
      });
    });

    it("evicts the connection's cached upstream session", async () => {
      // There was no eviction anywhere, so the cookies lived in process memory
      // until a restart -- and a re-link would be served a session for
      // credentials that had been deleted.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-a');
    });

    it('leaves the AppUser and the session alone', async () => {
      // Never sign a parent out of a household they still have. Even on the
      // last school the AppUser survives; getMe then reports schools: [] and
      // the UI routes to the connect screen.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1');

      const touchedModels = deletedWheres().map((entry) => entry.model);
      expect(touchedModels).not.toContain('appUser');
      expect(touchedModels).not.toContain('appSession');
    });

    it('never selects NULL-stamped students, even on the last school', async () => {
      // The plan said "include NULL-stamped students only when this is the
      // user's last connection", and that rule is household-BLIND: there is no
      // such thing as "NULL within this household", so on a deployment with
      // two households it selects every unattributed child in the database and
      // then deletes their entire history. The rule was the defect.
      //
      // Leaving them is safe: RosterPresenceService already retires a child who
      // stops appearing in any roster, and the next sync re-links the rest.
      //
      // Since ADR-0031 the selection runs over the link table, which cannot
      // express "unattributed" at all -- a child nobody lists simply has no
      // row here. That makes the old rule unreachable by construction, and
      // this test pins that it stays unreachable.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(0); // last school
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1');

      expect(mockPrisma.studentConnection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { householdConnectionId: 'conn-a' } }),
      );
      const selections = mockPrisma.studentConnection.findMany.mock.calls.map(
        (call) => call[0].where,
      );
      for (const where of selections) {
        expect(JSON.stringify(where)).not.toContain('null');
      }
    });

    it('unlinks every school when given no id', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.deleteConnection('user-1');

      expect(result).toEqual({ ok: true });
      // One transaction for the whole unlink, not one per school -- see
      // 'unlinks every school in ONE transaction' above for why.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-a');
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-b');
    });
  });
});
