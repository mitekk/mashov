import { ConfigService } from '@nestjs/config';
import { ChildrenService } from '../children/children.service';
import { MailService } from '../mail/mail.service';
import { MashovHttpClient } from './mashov-http.client';
import { MashovSessionService } from './mashov-session.service';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserItemStateService } from '../common/user-item-state.service';
import type { ConnectionTarget } from './connection-target';

/**
 * The fence around the shared env-credential session.
 *
 * `MashovHttpClient.get/getResponse/put/delete` and
 * `MashovSessionService.getAuthHeaders()` authenticate as whatever single
 * account `MASHOV_SEMEL`/`USERNAME`/`PASSWORD` names. They stay, because they
 * are load-bearing for boot, for `ensureStudentsAvailable` and for every sync
 * task's `useSharedSession` branch -- the only path on a fresh deploy and in
 * the integration tests.
 *
 * But no user-facing read service may touch them any more. On a two-school
 * household the env account is one school's credentials, so every one of these
 * calls either 403s on the other school's child or -- worse, for the
 * household-scoped endpoints -- silently answers about the wrong school. This
 * suite injects a client whose env methods throw and asserts they are never
 * reached, which is the only check that stays true as these services are
 * edited later.
 */

const TARGET: ConnectionTarget = {
  id: 'conn-a',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent-a',
  password: 'pw-a',
  schoolName: 'אורט רמון',
};

function fencedClient() {
  const fence = (name: string) =>
    jest.fn(() => {
      throw new Error(
        `env session is fenced off: ${name} authenticates as the MASHOV_* account, ` +
          'not as the connection that owns this row',
      );
    });

  return {
    // The env-session surface. Any call is a failure.
    get: fence('get'),
    getResponse: fence('getResponse'),
    put: fence('put'),
    delete: fence('delete'),
    // The per-connection surface. These are what the services must use.
    getForTarget: jest.fn().mockResolvedValue([]),
    getResponseForTarget: jest.fn().mockResolvedValue({
      data: Buffer.from('file'),
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }),
    putForTarget: jest.fn().mockResolvedValue(undefined),
    deleteForTarget: jest.fn().mockResolvedValue(undefined),
    getForConnection: jest.fn().mockResolvedValue([]),
  };
}

function scopeStub() {
  return {
    targetFor: jest.fn().mockResolvedValue(TARGET),
    targetForStudent: jest.fn().mockResolvedValue(TARGET),
    targetForConversation: jest.fn().mockResolvedValue(TARGET),
    targetForMessage: jest.fn().mockResolvedValue(TARGET),
    listTargets: jest.fn().mockResolvedValue([TARGET]),
    groupConversationsByConnection: jest
      .fn()
      .mockImplementation((ids: string[]) => Promise.resolve(new Map([['conn-a', ids]]))),
    studentGuidsForUser: jest.fn().mockResolvedValue(['guid-1']),
    stampStudent: jest.fn().mockResolvedValue(undefined),
  };
}

const STUDENT = {
  studentGuid: 'guid-1',
  fullName: 'Mika Kors',
  classCode: 'ז',
  classNum: 3,
  isActive: true,
  householdConnectionId: 'conn-a',
};

const CONVERSATION = {
  conversationId: 'conv-1',
  subject: 'Subject',
  senderNamePreview: 'Teacher',
  sendTime: new Date('2026-11-01T08:00:00Z'),
  isUnread: true,
  hasDrafts: false,
  hasAttachments: true,
  preventReply: false,
  labels: [],
  locallyReadThroughAt: null,
  locallyMarkedUnreadAt: null,
  lastFetchedAt: new Date('2026-11-01T08:00:00Z'),
  householdConnectionId: 'conn-a',
};

const MESSAGE = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  senderId: 's1',
  senderName: 'Teacher',
  subject: 'Subject',
  bodyHtmlSanitized: '<p>hi</p>',
  bodyTextPreview: 'hi',
  sendTime: new Date('2026-11-01T08:00:00Z'),
  isNew: false,
  recipients: [],
  files: [{ fileId: 'f1', fileName: 'note.pdf' }],
  preventReply: false,
  sentViaEmail: false,
  sentViaSms: false,
  householdConnectionId: 'conn-a',
};

function childrenPrisma() {
  return {
    student: {
      findUnique: jest.fn().mockResolvedValue(STUDENT),
      findFirst: jest.fn().mockResolvedValue(STUDENT),
      findMany: jest.fn().mockResolvedValue([STUDENT]),
    },
    homeworkItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'hw-1',
        studentGuid: 'guid-1',
        files: [{ fileId: 'f1', fileName: 'note.pdf' }],
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    behaviorItem: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conn-a', schoolYear: 2026, active: true }),
      findMany: jest.fn().mockResolvedValue([{ id: 'conn-a', schoolYear: 2026 }]),
    },
    messageBoardItem: { findMany: jest.fn().mockResolvedValue([]) },
    studentRelease: { findMany: jest.fn().mockResolvedValue([]) },
    schoolActivity: { findMany: jest.fn().mockResolvedValue([]) },
    timetableEntry: { findMany: jest.fn().mockResolvedValue([]) },
    subjectEnrollment: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function mailPrisma() {
  return {
    mailConversation: {
      findUnique: jest.fn().mockResolvedValue(CONVERSATION),
      findMany: jest.fn().mockResolvedValue([CONVERSATION]),
      update: jest.fn().mockResolvedValue(CONVERSATION),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      aggregate: jest.fn().mockResolvedValue({ _sum: { cachedNewCount: 1 } }),
    },
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(MESSAGE),
      findFirst: jest.fn().mockResolvedValue(MESSAGE),
      findMany: jest.fn().mockResolvedValue([MESSAGE]),
      upsert: jest.fn().mockResolvedValue(MESSAGE),
    },
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conn-a', cachedNewCount: 1, active: true }),
      findMany: jest.fn().mockResolvedValue([{ id: 'conn-a', cachedNewCount: 1 }]),
      update: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _sum: { cachedNewCount: 1 } }),
    },
    syncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    userItemState: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('the shared env session is fenced off from user-facing reads', () => {
  function assertFenceIntact(client: ReturnType<typeof fencedClient>) {
    expect(client.get).not.toHaveBeenCalled();
    expect(client.getResponse).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  }

  describe('ChildrenService', () => {
    let client: ReturnType<typeof fencedClient>;
    let scope: ReturnType<typeof scopeStub>;
    let service: ChildrenService;

    beforeEach(() => {
      client = fencedClient();
      scope = scopeStub();
      service = new ChildrenService(
        childrenPrisma() as unknown as PrismaService,
        { ensureStudentsAvailable: jest.fn() } as unknown as MashovSessionService,
        client as unknown as MashovHttpClient,
        { getState: jest.fn().mockResolvedValue({ isNew: false, isArchived: false }) } as unknown as UserItemStateService,
        { get: jest.fn() } as unknown as ConfigService,
        scope as unknown as ConnectionScopeService,
      );
    });

    it('reads lesson plans through the owning connection', async () => {
      await service.getLessonPlans('guid-1');

      expect(client.getForTarget).toHaveBeenCalled();
      expect(scope.targetForStudent).toHaveBeenCalledWith('guid-1', undefined);
      assertFenceIntact(client);
    });

    it('reads lesson history through the owning connection', async () => {
      await service.getLessonHistory('guid-1');

      expect(client.getForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('reads student releases through the owning connection', async () => {
      await service.getStudentReleases('guid-1');

      expect(client.getForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it("reads school activities through that child's own school", async () => {
      // The endpoint takes no studentGuid and is household-scoped upstream, so
      // it answers for whichever account asked. Routing it through the child's
      // own connection is what makes the answer belong to the right school.
      await service.getSchoolActivities('guid-1');

      expect(client.getForTarget).toHaveBeenCalled();
      expect(scope.targetForStudent).toHaveBeenCalledWith('guid-1', undefined);
      assertFenceIntact(client);
    });

    it('writes a release request through the owning connection', async () => {
      await service.createStudentRelease('guid-1', { date: '2026-11-20' });

      expect(client.putForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('updates a release request through the owning connection', async () => {
      await service.updateStudentRelease('guid-1', 7, { date: '2026-11-21' });

      expect(client.putForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('deletes a release request through the owning connection', async () => {
      await service.deleteStudentRelease('guid-1', 7);

      expect(client.deleteForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('downloads a homework attachment through the owning connection', async () => {
      await service.downloadHomeworkAttachment('guid-1', 'hw-1', 'f1');

      expect(client.getResponseForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });
  });

  describe('MailService', () => {
    let client: ReturnType<typeof fencedClient>;
    let scope: ReturnType<typeof scopeStub>;
    let service: MailService;

    beforeEach(() => {
      client = fencedClient();
      scope = scopeStub();
      service = new MailService(
        mailPrisma() as unknown as PrismaService,
        client as unknown as MashovHttpClient,
        scope as unknown as ConnectionScopeService,
      );
    });

    it('hydrates a conversation through its own mailbox', async () => {
      const prisma = mailPrisma();
      // No stored body, so the detail read must reach upstream.
      prisma.mailMessage.findMany.mockResolvedValue([{ ...MESSAGE, bodyHtmlSanitized: null }]);
      const bodyless = new MailService(
        prisma as unknown as PrismaService,
        client as unknown as MashovHttpClient,
        scope as unknown as ConnectionScopeService,
      );

      await bodyless.getConversationDetail('conv-1');

      expect(client.getForTarget).toHaveBeenCalled();
      expect(scope.targetForConversation).toHaveBeenCalledWith('conv-1');
      assertFenceIntact(client);
    });

    it('downloads a mail attachment through its own mailbox', async () => {
      await service.downloadMessageAttachment('conv-1', 'msg-1', 'f1');

      expect(client.getResponseForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('marks unread through the owning connection', async () => {
      await service.markUnread(['conv-1']);

      expect(client.putForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('archives through the owning connection', async () => {
      await service.archive(['conv-1']);

      expect(client.putForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });

    it('unarchives through the owning connection', async () => {
      await service.unarchive(['conv-1']);

      expect(client.putForTarget).toHaveBeenCalled();
      assertFenceIntact(client);
    });
  });
});
