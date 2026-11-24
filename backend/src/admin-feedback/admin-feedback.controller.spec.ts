import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { CloudflareAccessGuard } from '../admin-auth/cloudflare-access.guard';
import { AdminFeedbackController } from './admin-feedback.controller';
import type { AdminFeedbackService } from './admin-feedback.service';

const PAGE = {
  data: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

function build() {
  const list = jest.fn().mockResolvedValue(PAGE);
  const detail = jest.fn().mockResolvedValue({ id: 'fb-1' });
  const markResponded = jest.fn().mockResolvedValue({ id: 'fb-1' });
  const service = { list, detail, markResponded } as unknown as AdminFeedbackService;
  return { controller: new AdminFeedbackController(service), list, detail, markResponded };
}

describe('AdminFeedbackController', () => {
  it('passes the filter, page and limit straight through', async () => {
    const { controller, list } = build();

    await controller.list({ filter: 'awaiting', page: 3, limit: 50 });

    expect(list).toHaveBeenCalledWith('awaiting', 3, 50);
  });

  it('wraps the detail and the response transition in { data }', async () => {
    const { controller, detail, markResponded } = build();

    expect(await controller.detail('fb-1')).toEqual({ data: { id: 'fb-1' } });
    expect(detail).toHaveBeenCalledWith('fb-1');

    expect(await controller.markResponded('fb-1')).toEqual({ data: { id: 'fb-1' } });
    expect(markResponded).toHaveBeenCalledWith('fb-1');
  });

  it('returns the list envelope unwrapped, as the contract table says', async () => {
    const { controller } = build();
    expect(await controller.list({ filter: 'all', page: 1, limit: 20 })).toEqual(PAGE);
  });

  describe('guards', () => {
    const reflector = new Reflector();

    it('is @Public(), so the PARENT session guard stands down', () => {
      // An operator has no mashov_session cookie and no household. Without
      // this, every admin route 401s before the Access guard is reached.
      expect(reflector.get<boolean>(IS_PUBLIC_KEY, AdminFeedbackController)).toBe(true);
    });

    it('is gated by CloudflareAccessGuard, which is the REAL boundary', () => {
      // The pairing is load-bearing: @Public() alone would publish every
      // parent's report to anyone who can reach the origin directly.
      const guards = reflector.get<unknown[]>('__guards__', AdminFeedbackController) ?? [];
      expect(guards).toContain(CloudflareAccessGuard);
    });
  });
});
