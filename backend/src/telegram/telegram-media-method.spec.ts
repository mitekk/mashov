import {
  DEFAULT_PHOTO_MAX_BYTES,
  chooseTelegramMediaMethod,
} from './telegram-media-method';

const SMALL = 200 * 1024;

describe('chooseTelegramMediaMethod', () => {
  it.each(['image/jpeg', 'image/png'])('sends a small %s as a photo, so it previews inline', (contentType) => {
    expect(chooseTelegramMediaMethod(contentType, SMALL)).toBe('sendPhoto');
  });

  it('reads the content type case-insensitively and past its parameters', () => {
    expect(chooseTelegramMediaMethod('IMAGE/JPEG; charset=binary', SMALL)).toBe('sendPhoto');
  });

  it('sends a large jpeg as a document instead of letting Telegram refuse it', () => {
    // sendPhoto's bot-upload ceiling is 10 MB and lower than sendDocument's.
    expect(chooseTelegramMediaMethod('image/jpeg', DEFAULT_PHOTO_MAX_BYTES + 1)).toBe(
      'sendDocument',
    );
  });

  it('honours an explicit photo ceiling', () => {
    expect(chooseTelegramMediaMethod('image/jpeg', 2048, 1024)).toBe('sendDocument');
    expect(chooseTelegramMediaMethod('image/jpeg', 512, 1024)).toBe('sendPhoto');
  });

  it.each([
    'application/pdf',
    'image/gif',
    'image/svg+xml',
    'image/heic',
    'image/webp',
    'image/tiff',
    'application/msword',
    'application/octet-stream',
    'text/plain',
  ])('sends %s as a document', (contentType) => {
    // sendPhoto re-encodes and downscales -- a scanned permission slip comes
    // out unreadable -- and refuses a non-image opaquely. PDFs preview
    // natively as documents anyway.
    expect(chooseTelegramMediaMethod(contentType, SMALL)).toBe('sendDocument');
  });

  it.each([null, undefined, '', '   '])('sends an unknown type (%p) as a document', (contentType) => {
    expect(chooseTelegramMediaMethod(contentType, SMALL)).toBe('sendDocument');
  });
});
