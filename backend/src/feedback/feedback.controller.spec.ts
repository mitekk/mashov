import type { Request } from 'express';
import { FeedbackController } from './feedback.controller';
import type { FeedbackService } from './feedback.service';

/**
 * The controller's whole job is saying who is asking and what they were
 * running. The DTO rules are exercised against the real ValidationPipe in
 * tests/integration/feedback.test.ts; what cannot be covered there is the one
 * field the client is deliberately not trusted with.
 */
describe('FeedbackController', () => {
  function makeRequest(options: { userId?: string; userAgent?: string } = {}): Request {
    return {
      user: options.userId ? { userId: options.userId } : undefined,
      headers: options.userAgent ? { 'user-agent': options.userAgent } : {},
    } as unknown as Request;
  }

  function makeService() {
    return {
      create: jest.fn().mockResolvedValue({
        id: 'feedback-1',
        subject: 'bug',
        createdAt: '2026-11-23T10:00:00.000Z',
      }),
    } as unknown as jest.Mocked<FeedbackService>;
  }

  const body = { subject: 'bug' as const, content: 'הציון בחשבון שגוי' };

  it('refuses an unauthenticated report with the standard envelope', async () => {
    const service = makeService();
    const controller = new FeedbackController(service);

    await expect(controller.create(body, makeRequest())).rejects.toMatchObject({
      status: 401,
      response: { error: { code: 'UNAUTHORIZED' } },
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('hands the service the caller and the user agent read from the header', async () => {
    const service = makeService();
    const controller = new FeedbackController(service);

    await controller.create(
      body,
      makeRequest({ userId: 'user-1', userAgent: 'Mozilla/5.0 (iPhone)' }),
    );

    expect(service.create).toHaveBeenCalledWith('user-1', body, 'Mozilla/5.0 (iPhone)');
  });

  it('passes no user agent when the request carried none', async () => {
    const service = makeService();
    const controller = new FeedbackController(service);

    await controller.create(body, makeRequest({ userId: 'user-1' }));

    expect(service.create).toHaveBeenCalledWith('user-1', body, undefined);
  });

  it('wraps the receipt in the { data } envelope', async () => {
    const service = makeService();
    const controller = new FeedbackController(service);

    const result = await controller.create(body, makeRequest({ userId: 'user-1' }));

    expect(result).toEqual({
      data: { id: 'feedback-1', subject: 'bug', createdAt: '2026-11-23T10:00:00.000Z' },
    });
  });
});
