import { ConfigService } from '@nestjs/config';
import { isMediaEnabled } from './telegram-media.module';
import { NO_MEDIA_DELIVERY } from './media-delivery.interface';

function config(value?: string): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

describe('isMediaEnabled', () => {
  it.each([undefined, '', 'true', 'TRUE', 'yes', '1'])('is on for %p', (value) => {
    // Defaults to true, unlike the digest's own switches: the feature was
    // asked for, and DIGEST_ENABLED / INBOX_NOTIFY_ENABLED still gate
    // everything that would call it.
    expect(isMediaEnabled(config(value))).toBe(true);
  });

  it.each(['false', 'FALSE', ' false '])('is off for %p', (value) => {
    expect(isMediaEnabled(config(value))).toBe(false);
  });
});

describe('NO_MEDIA_DELIVERY', () => {
  it('reports itself disabled, so a caller skips enumerating attachments', async () => {
    expect(NO_MEDIA_DELIVERY.enabled).toBe(false);
    expect(NO_MEDIA_DELIVERY.budgetBytes()).toBe(0);
  });

  it('answers every ref with a note rather than silence', async () => {
    const result = await NO_MEDIA_DELIVERY.fetch('user-a', [
      { kind: 'mail', ownerId: 'c', itemId: 'm', fileId: 'f', fileName: 'a.pdf' },
    ], 0);

    expect(result.items[0].file).toBeUndefined();
    expect(result.items[0].note).toContain('disabled');
  });

  it('sends nothing and fails nothing', async () => {
    expect(await NO_MEDIA_DELIVERY.send('chat-1', [])).toEqual({ sent: 0, notes: [] });
  });
});
