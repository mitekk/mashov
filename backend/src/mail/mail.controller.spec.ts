import type { Request, Response } from 'express';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';

/**
 * The controller's only job on every route is to say who is asking.
 *
 * `MailService`'s scoping is covered at the service boundary, and that cover
 * is worth nothing on a route that forgets to pass `userId`: every method
 * treats an absent caller as "no filter", deliberately, for the
 * unauthenticated server-side path. So the wiring is the whole guard here, and
 * it was the one part of R1 no test exercised.
 */
describe('MailController', () => {
  const USER = 'user-mine';

  function makeRequest(userId?: string): Request {
    return { user: userId ? { userId } : undefined } as unknown as Request;
  }

  function makeResponse(): Response {
    return { setHeader: jest.fn() } as unknown as Response;
  }

  function makeService() {
    return {
      getSummary: jest.fn().mockResolvedValue({}),
      getConversations: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
      getConversationDetail: jest.fn().mockResolvedValue({}),
      downloadMessageAttachment: jest.fn().mockResolvedValue({
        buffer: Buffer.from('file'),
        contentType: 'application/pdf',
        contentDisposition: null,
        fileName: 'note.pdf',
      }),
      markConversationsRead: jest.fn().mockResolvedValue({ updated: 0 }),
      markUnread: jest.fn().mockResolvedValue({ updated: 0 }),
      archive: jest.fn().mockResolvedValue({ updated: 0 }),
      unarchive: jest.fn().mockResolvedValue({ updated: 0 }),
    };
  }

  /** Every route, with the service method it must hand the caller to. */
  const ROUTES: Array<{
    name: keyof ReturnType<typeof makeService>;
    call: (controller: MailController, req: Request) => Promise<unknown>;
  }> = [
    { name: 'getSummary', call: (controller, req) => controller.getSummary(req) },
    {
      name: 'getConversations',
      call: (controller, req) => controller.getConversations({}, req),
    },
    { name: 'getConversationDetail', call: (controller, req) => controller.getConversation('conv-1', req) },
    {
      name: 'downloadMessageAttachment',
      call: (controller, req) =>
        controller.downloadMessageAttachment('conv-1', 'msg-1', 'file-1', makeResponse(), req),
    },
    {
      name: 'markConversationsRead',
      call: (controller, req) => controller.markRead({ conversationIds: ['conv-1'] }, req),
    },
    {
      name: 'markUnread',
      call: (controller, req) => controller.markUnread({ conversationIds: ['conv-1'] }, req),
    },
    {
      name: 'archive',
      call: (controller, req) => controller.archive({ conversationIds: ['conv-1'] }, req),
    },
    {
      name: 'unarchive',
      call: (controller, req) => controller.unarchive({ conversationIds: ['conv-1'] }, req),
    },
  ];

  it.each(ROUTES)('$name receives the signed-in caller', async ({ name, call }) => {
    const service = makeService();
    const controller = new MailController(service as unknown as MailService);

    await call(controller, makeRequest(USER));

    expect(service[name]).toHaveBeenCalled();
    expect(service[name].mock.calls[0]).toContain(USER);
  });

  it.each(ROUTES)('$name passes undefined rather than inventing a caller', async ({ name, call }) => {
    // The unauthenticated path exists (`tests/integration/api.test.ts` drives
    // mail through it) and must stay unscoped rather than be given a
    // fabricated id.
    const service = makeService();
    const controller = new MailController(service as unknown as MailService);

    await call(controller, makeRequest());

    expect(service[name]).toHaveBeenCalled();
    expect(service[name].mock.calls[0]).not.toContain(USER);
  });
});
