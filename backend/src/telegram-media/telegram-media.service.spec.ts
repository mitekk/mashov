import { TelegramMediaService } from './telegram-media.service';
import type { MediaAttachmentRef } from './media-delivery.interface';
import type { ConfigService } from '@nestjs/config';
import type { MailService } from '../mail/mail.service';
import type { ChildrenService } from '../children/children.service';
import type { MediaSender } from '../telegram/telegram-media.sender';

const USER = 'user-a';

function ref(overrides: Partial<MediaAttachmentRef> = {}): MediaAttachmentRef {
  return {
    kind: 'mail',
    ownerId: 'conv-1',
    itemId: 'msg-1',
    fileId: 'file-1',
    fileName: 'אישור הורים.pdf',
    ...overrides,
  };
}

function downloaded(bytes = 1024) {
  return {
    buffer: Buffer.alloc(bytes, 7),
    contentType: 'application/pdf',
    contentDisposition: null,
    fileName: 'אישור הורים.pdf',
  };
}

interface HarnessOptions {
  mailDownload?: jest.Mock;
  homeworkDownload?: jest.Mock;
  behaviorDownload?: jest.Mock;
  sendMedia?: jest.Mock;
  env?: Record<string, string>;
}

function makeHarness(options: HarnessOptions = {}) {
  const mailDownload = options.mailDownload ?? jest.fn().mockResolvedValue(downloaded());
  const homeworkDownload = options.homeworkDownload ?? jest.fn().mockResolvedValue(downloaded());
  const behaviorDownload = options.behaviorDownload ?? jest.fn().mockResolvedValue(downloaded());
  const sendMedia = options.sendMedia ?? jest.fn().mockResolvedValue(undefined);

  const config = {
    get: jest.fn((key: string) => ({
      // Zero, so the specs do not spend a second per file waiting out the
      // real per-chat rate limit.
      MEDIA_SEND_DELAY_MS: '0',
      ...options.env,
    })[key]),
  } as unknown as ConfigService;

  const service = new TelegramMediaService(
    config,
    { downloadMessageAttachment: mailDownload } as unknown as MailService,
    {
      downloadHomeworkAttachment: homeworkDownload,
      downloadBehaviorAttachment: behaviorDownload,
    } as unknown as ChildrenService,
    { sendMedia } as unknown as MediaSender,
  );

  return { service, mailDownload, homeworkDownload, behaviorDownload, sendMedia };
}

describe('TelegramMediaService.fetch', () => {
  it('downloads a mail attachment through the route’s own method', async () => {
    // Not through the Mashov client directly: that method's 4th argument is an
    // AppUser.id and it enforces visibility with it, so a file belonging to a
    // child the parent no longer owns still 404s.
    const harness = makeHarness();

    const result = await harness.service.fetch(USER, [ref()], 50 * 1024 * 1024);

    expect(harness.mailDownload).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      'file-1',
      USER,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(result.items[0].file?.buffer.byteLength).toBe(1024);
    expect(result.items[0].file?.contentType).toBe('application/pdf');
  });

  it('downloads a homework attachment as the subscribing parent', async () => {
    const harness = makeHarness();

    await harness.service.fetch(
      USER,
      [ref({ kind: 'homework', ownerId: 'stu-1', itemId: 'hw-1' })],
      50 * 1024 * 1024,
    );

    expect(harness.homeworkDownload).toHaveBeenCalledWith(
      'stu-1',
      'hw-1',
      'file-1',
      USER,
      expect.any(Object),
    );
  });

  it('downloads a behavior attachment as the subscribing parent', async () => {
    const harness = makeHarness();

    await harness.service.fetch(
      USER,
      [ref({ kind: 'behavior', ownerId: 'stu-1', itemId: 'beh-1' })],
      50 * 1024 * 1024,
    );

    expect(harness.behaviorDownload).toHaveBeenCalledWith(
      'stu-1',
      'beh-1',
      'file-1',
      USER,
      expect.any(Object),
    );
  });

  it('isolates a failed download, so the others still arrive', async () => {
    const harness = makeHarness({
      mailDownload: jest
        .fn()
        .mockRejectedValueOnce(new Error('Attachment download failed'))
        .mockResolvedValueOnce(downloaded()),
    });

    const result = await harness.service.fetch(
      USER,
      [ref({ fileId: 'bad' }), ref({ fileId: 'good' })],
      50 * 1024 * 1024,
    );

    expect(result.items[0].file).toBeUndefined();
    expect(result.items[0].note).toContain('download failed');
    expect(result.items[1].file).toBeDefined();
  });

  it('never throws out of fetch, whatever the downloader does', async () => {
    const harness = makeHarness({
      mailDownload: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(harness.service.fetch(USER, [ref()], 50 * 1024 * 1024)).resolves.toBeDefined();
  });

  it('marks a file past the ceiling as too large rather than uploading it', async () => {
    const harness = makeHarness({
      env: { TELEGRAM_MEDIA_MAX_BYTES: '512' },
      mailDownload: jest.fn().mockResolvedValue(downloaded(1024)),
    });

    const result = await harness.service.fetch(USER, [ref()], 50 * 1024 * 1024);

    expect(result.items[0].tooLarge).toBe(true);
    expect(result.items[0].file).toBeUndefined();
    expect(result.items[0].note).toMatch(/too large/i);
  });

  it('stops at the per-message file cap and says so', async () => {
    const harness = makeHarness({ env: { MEDIA_MAX_FILES_PER_MESSAGE: '2' } });

    const result = await harness.service.fetch(
      USER,
      [ref({ fileId: 'a' }), ref({ fileId: 'b' }), ref({ fileId: 'c' })],
      50 * 1024 * 1024,
    );

    expect(harness.mailDownload).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(3);
    expect(result.items[2].file).toBeUndefined();
    expect(result.items[2].note).toMatch(/too many/i);
  });

  it('stops downloading once the byte budget is spent', async () => {
    // No size is known before the download, so the budget is a stop condition
    // checked after each one: it can overshoot by at most one file, which
    // TELEGRAM_MEDIA_MAX_BYTES already bounds.
    const harness = makeHarness({ mailDownload: jest.fn().mockResolvedValue(downloaded(1024)) });

    const result = await harness.service.fetch(
      USER,
      [ref({ fileId: 'a' }), ref({ fileId: 'b' })],
      1000,
    );

    expect(harness.mailDownload).toHaveBeenCalledTimes(1);
    expect(result.items[0].file).toBeDefined();
    expect(result.items[1].file).toBeUndefined();
    expect(result.items[1].note).toMatch(/budget/i);
    expect(result.remainingBytes).toBeLessThanOrEqual(0);
  });

  it('reports the budget it has left, so a caller can thread it on', async () => {
    const harness = makeHarness({ mailDownload: jest.fn().mockResolvedValue(downloaded(1000)) });

    const result = await harness.service.fetch(USER, [ref()], 5000);

    expect(result.remainingBytes).toBe(4000);
  });

  it('carries the caption the caller composed', async () => {
    const harness = makeHarness();

    const result = await harness.service.fetch(
      USER,
      [ref({ caption: 'אישור הורים.pdf — טיול שנתי' })],
      50 * 1024 * 1024,
    );

    expect(result.items[0].file?.caption).toBe('אישור הורים.pdf — טיול שנתי');
  });

  it('reports itself enabled, unlike the no-op binding', () => {
    expect(makeHarness().service.enabled).toBe(true);
  });
});

describe('TelegramMediaService.send', () => {
  async function fetched(harness: ReturnType<typeof makeHarness>, count: number) {
    const refs = Array.from({ length: count }, (_, i) => ref({ fileId: `f${i}` }));
    return (await harness.service.fetch(USER, refs, 50 * 1024 * 1024)).items;
  }

  it('uploads each file and counts what went out', async () => {
    const harness = makeHarness();

    const result = await harness.service.send('chat-1', await fetched(harness, 2));

    expect(harness.sendMedia).toHaveBeenCalledTimes(2);
    expect(harness.sendMedia.mock.calls[0][0]).toBe('chat-1');
    expect(result).toEqual({ sent: 2, notes: [] });
  });

  it('skips an item that was never downloaded', async () => {
    const harness = makeHarness({
      mailDownload: jest.fn().mockRejectedValue(new Error('gone')),
    });

    const result = await harness.service.send('chat-1', await fetched(harness, 1));

    expect(harness.sendMedia).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it('isolates a failed upload and records it as a note', async () => {
    const harness = makeHarness({
      sendMedia: jest
        .fn()
        .mockRejectedValueOnce(new Error('Telegram sendDocument failed: HTTP 500'))
        .mockResolvedValueOnce(undefined),
    });

    const result = await harness.service.send('chat-1', await fetched(harness, 2));

    expect(result.sent).toBe(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('HTTP 500');
  });

  it('never throws out of send, so a bad attachment cannot fail the text', async () => {
    // The text message is the only thing gating ledger confirmation. A throw
    // here would release the claims and re-send the whole thing next run.
    const harness = makeHarness({
      sendMedia: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      harness.service.send('chat-1', await fetched(harness, 1)),
    ).resolves.toMatchObject({ sent: 0 });
  });

  it('treats a 429 as a transient skip rather than a failure to retry now', async () => {
    const harness = makeHarness({
      sendMedia: jest
        .fn()
        .mockRejectedValue(new Error('Telegram sendDocument failed: Too Many Requests: retry after 30')),
    });

    const result = await harness.service.send('chat-1', await fetched(harness, 1));

    expect(result.sent).toBe(0);
    expect(result.notes[0]).toMatch(/rate limit/i);
  });

  it('paces the uploads, because Telegram allows about one message a second per chat', async () => {
    const harness = makeHarness({ env: { MEDIA_SEND_DELAY_MS: '30' } });
    const items = await fetched(harness, 3);

    const started = Date.now();
    await harness.service.send('chat-1', items);

    // Two gaps for three files, and no gap before the first.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
