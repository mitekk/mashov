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
  syncRun: { deleteMany: jest.fn() },
  homeworkItem: { deleteMany: jest.fn() },
  behaviorItem: { deleteMany: jest.fn() },
  messageBoardItem: { deleteMany: jest.fn() },
  timetableEntry: { deleteMany: jest.fn() },
  mailMessage: { deleteMany: jest.fn() },
  mailConversation: { deleteMany: jest.fn() },
  notificationEvent: { deleteMany: jest.fn() },
  // Both were missing from the old transaction entirely.
  studentRelease: { deleteMany: jest.fn() },
  schoolActivity: { deleteMany: jest.fn() },
  parentProfile: { deleteMany: jest.fn() },
  behaviorTypeReference: { deleteMany: jest.fn() },
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
        ['behaviorTypeReference', mockPrisma.behaviorTypeReference.deleteMany],
        ['syncRun', mockPrisma.syncRun.deleteMany],
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
      mockPrisma.student.findMany.mockResolvedValue([{ studentGuid: 'guid-a' }]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      for (const { model, where } of deletedWheres()) {
        expect(where).toBeDefined();
        expect(where).not.toEqual({});
        if (model === 'mailMessage' || model === 'mailConversation') {
          expect(where).toEqual({ householdConnectionId: 'conn-a' });
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

      expect(mockPrisma.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { householdConnectionId: 'conn-a' } }),
      );
    });

    it('takes the NULL-stamped children too, but only on the last school', async () => {
      // Before then NULL means "ownership unknown", and such a child may
      // belong to the school that is staying.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(0); // nothing remains
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1');

      expect(mockPrisma.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ householdConnectionId: 'conn-a' }, { householdConnectionId: null }],
          },
        }),
      );
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

    it('now deletes studentRelease and schoolActivity', async () => {
      // Both were missing from the transaction entirely, so a parent's
      // early-release requests and consent answers survived an unlink and
      // reappeared on re-link.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.student.findMany.mockResolvedValue([{ studentGuid: 'guid-a' }]);
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.deleteConnection('user-1', 'conn-a');

      expect(mockPrisma.studentRelease.deleteMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['guid-a'] } },
      });
      expect(mockPrisma.schoolActivity.deleteMany).toHaveBeenCalledWith({
        where: { householdConnectionId: 'conn-a' },
      });
    });

    it('deletes the student rows rather than orphaning them', async () => {
      // They used to survive with isActive: true, so the REMAINING school's
      // per-student crons 403'd on every one of them every twelve minutes,
      // forever.
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A]);
      mockPrisma.householdConnection.count.mockResolvedValue(1);
      mockPrisma.student.findMany.mockResolvedValue([{ studentGuid: 'guid-a' }]);
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

    it('unlinks every school when given no id', async () => {
      mockPrisma.householdConnection.findMany.mockResolvedValue([CONN_A, CONN_B]);
      mockPrisma.householdConnection.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.deleteConnection('user-1');

      expect(result).toEqual({ ok: true });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-a');
      expect(mockSessionService.invalidateConnection).toHaveBeenCalledWith('conn-b');
    });
  });
});
