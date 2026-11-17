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
    update: jest.fn(),
    delete: jest.fn(),
  },
  student: { findMany: jest.fn().mockResolvedValue([]) },
  syncRun: { deleteMany: jest.fn() },
  homeworkItem: { deleteMany: jest.fn() },
  behaviorItem: { deleteMany: jest.fn() },
  messageBoardItem: { deleteMany: jest.fn() },
  timetableEntry: { deleteMany: jest.fn() },
  mailMessage: { deleteMany: jest.fn() },
  mailConversation: { deleteMany: jest.fn() },
  notificationEvent: { deleteMany: jest.fn() },
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
    it('throws 404 when no connection found', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      await expect(service.deleteConnection('user-1')).rejects.toThrow(NotFoundException);
    });

    it('runs transaction to delete all data and returns ok', async () => {
      mockPrisma.householdConnection.findFirst.mockResolvedValue({ id: 'conn-1' });
      mockPrisma.student.findMany.mockResolvedValue([{ studentGuid: 'sg-1' }]);
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.deleteConnection('user-1');

      expect(result).toEqual({ ok: true });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });
});
