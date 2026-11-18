/**
 * Unit tests for the attachment viewer's pure helpers.
 *
 * These live under `tests/integration/` rather than beside the source they
 * cover, which deviates from the "unit tests alongside source" rule in
 * `.claude/rules/testing.md`. That rule is unsatisfiable for frontend code as
 * things stand: `frontend/package.json` has no test runner at all, and the
 * docker `unit` service runs only the backend suite, so a frontend-local test
 * would not be executed by CI even if a runner were added. The root jest
 * project already maps `@/*` to `frontend/src/*` and runs in CI via
 * `npm run test:integration`, so pure functions are testable here today with
 * no new tooling. Adding jsdom + testing-library is a tooling decision worth
 * making on its own merits, not smuggled in with a feature.
 */

import {
  behaviorAttachmentHref,
  homeworkAttachmentHref,
  mailAttachmentHref,
} from '@/lib/attachment-routes';
import {
  formatFileSize,
  isSvg,
  previewKindFor,
  resolveMimeType,
} from '@/lib/mime';
import {
  AttachmentError,
  ATTACHMENT_TIMEOUT_CODE,
  describeAttachmentError,
} from '@/lib/attachment-errors';

describe('resolveMimeType', () => {
  it('trusts an informative header over the filename extension', () => {
    expect(resolveMimeType('image/png', 'scan.pdf')).toBe('image/png');
  });

  it('derives from the filename extension when the header is octet-stream', () => {
    expect(resolveMimeType('application/octet-stream', 'permission-slip.pdf')).toBe(
      'application/pdf',
    );
  });

  it('derives from the filename extension for every other uninformative header', () => {
    expect(resolveMimeType('binary/octet-stream', 'a.png')).toBe('image/png');
    expect(resolveMimeType('application/download', 'a.png')).toBe('image/png');
    expect(resolveMimeType('application/force-download', 'a.png')).toBe('image/png');
  });

  it('derives from the filename extension when there is no header at all', () => {
    expect(resolveMimeType(null, 'notes.txt')).toBe('text/plain');
    expect(resolveMimeType(undefined, 'notes.txt')).toBe('text/plain');
    expect(resolveMimeType('', 'notes.txt')).toBe('text/plain');
  });

  it('strips charset parameters and normalizes case and whitespace', () => {
    expect(resolveMimeType('text/plain; charset=utf-8', 'notes.txt')).toBe('text/plain');
    expect(resolveMimeType('  TEXT/CSV ; charset=windows-1255', 'x.csv')).toBe('text/csv');
  });

  it('falls back to octet-stream when neither source is informative', () => {
    expect(resolveMimeType('application/octet-stream', 'scan')).toBe('application/octet-stream');
    expect(resolveMimeType(null, 'scan')).toBe('application/octet-stream');
  });

  it('ignores a dotfile name with no real extension', () => {
    expect(resolveMimeType(null, '.gitignore')).toBe('application/octet-stream');
    expect(resolveMimeType(null, 'trailing.')).toBe('application/octet-stream');
  });

  it('uses the last extension of a multi-dot name', () => {
    expect(resolveMimeType(null, 'report.2026.final.pdf')).toBe('application/pdf');
  });

  it('resolves an unknown extension to the uninformative header it was given', () => {
    expect(resolveMimeType('application/octet-stream', 'archive.xyz')).toBe(
      'application/octet-stream',
    );
  });
});

describe('previewKindFor', () => {
  it.each([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml',
  ])('renders %s as an image', (mime) => {
    expect(previewKindFor(mime, 'file.bin')).toBe('image');
  });

  it('renders application/pdf as a pdf', () => {
    expect(previewKindFor('application/pdf', 'letter.pdf')).toBe('pdf');
  });

  it.each(['text/plain', 'text/csv', 'text/markdown'])('renders %s as text', (mime) => {
    expect(previewKindFor(mime, 'file.bin')).toBe('text');
  });

  it('refuses to preview text/html — an upstream error page must not look like a document', () => {
    expect(previewKindFor('text/html', 'error.html')).toBe('unsupported');
  });

  it('refuses to preview application/xml', () => {
    expect(previewKindFor('application/xml', 'data.xml')).toBe('unsupported');
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'form.docx'],
    ['application/vnd.ms-excel', 'grades.xls'],
    ['application/zip', 'bundle.zip'],
    ['application/octet-stream', 'mystery'],
    ['', 'mystery'],
  ])('treats %s as unsupported', (mime, fileName) => {
    expect(previewKindFor(mime, fileName)).toBe('unsupported');
  });

  it('detects SVG from the filename even when the header claims another image type', () => {
    expect(previewKindFor('image/png', 'evil.svg')).toBe('image');
    expect(isSvg('image/png', 'evil.svg')).toBe(true);
  });

  it('detects SVG from the header even when the filename says otherwise', () => {
    expect(previewKindFor('image/svg+xml', 'logo.png')).toBe('image');
    expect(isSvg('image/svg+xml', 'logo.png')).toBe(true);
  });

  it('does not call a plain PNG an SVG', () => {
    expect(isSvg('image/png', 'logo.png')).toBe(false);
  });

  it('strips parameters before matching', () => {
    expect(previewKindFor('text/plain; charset=utf-8', 'notes.txt')).toBe('text');
    expect(previewKindFor('APPLICATION/PDF', 'letter.pdf')).toBe('pdf');
  });
});

describe('attachment route builders', () => {
  it('builds a mail attachment href', () => {
    expect(mailAttachmentHref('conv-1', 'msg-1')('file-1')).toBe(
      '/api/v1/mail/conversations/conv-1/messages/msg-1/files/file-1',
    );
  });

  it('builds a homework attachment href', () => {
    expect(homeworkAttachmentHref('guid-1', 'hw-1')('hw-file-1')).toBe(
      '/api/v1/children/guid-1/homework/hw-1/files/hw-file-1',
    );
  });

  it('builds a behavior attachment href', () => {
    expect(behaviorAttachmentHref('guid-1', 'beh-1')('beh-file-1')).toBe(
      '/api/v1/children/guid-1/behavior/beh-1/files/beh-file-1',
    );
  });

  it('encodes every segment, not just the file id', () => {
    // The old inline interpolation encoded only the file id, so an owning id
    // carrying a slash silently escaped its route.
    expect(mailAttachmentHref('conv/1', 'msg?x=1')('file#1')).toBe(
      '/api/v1/mail/conversations/conv%2F1/messages/msg%3Fx%3D1/files/file%231',
    );
    expect(homeworkAttachmentHref('guid/1', 'hw 1')('a&b')).toBe(
      '/api/v1/children/guid%2F1/homework/hw%201/files/a%26b',
    );
    expect(behaviorAttachmentHref('guid/1', 'beh#1')('c+d')).toBe(
      '/api/v1/children/guid%2F1/behavior/beh%231/files/c%2Bd',
    );
  });

  it('encodes Hebrew file ids', () => {
    expect(homeworkAttachmentHref('guid-1', 'hw-1')('אישור הורים.pdf')).toBe(
      '/api/v1/children/guid-1/homework/hw-1/files/' +
        '%D7%90%D7%99%D7%A9%D7%95%D7%A8%20%D7%94%D7%95%D7%A8%D7%99%D7%9D.pdf',
    );
  });

  it('returns a stable builder that can be called repeatedly', () => {
    const build = homeworkAttachmentHref('guid-1', 'hw-1');
    expect(build('a')).toBe('/api/v1/children/guid-1/homework/hw-1/files/a');
    expect(build('b')).toBe('/api/v1/children/guid-1/homework/hw-1/files/b');
  });
});

describe('describeAttachmentError', () => {
  it('reports a missing file as gone from Mashov, with retry', () => {
    expect(describeAttachmentError(new AttachmentError(404, 'NOT_FOUND'))).toEqual({
      message: 'הקובץ אינו זמין יותר במשוב',
      canRetry: true,
    });
  });

  it('reports a gateway timeout as a timeout, with retry', () => {
    expect(describeAttachmentError(new AttachmentError(504, 'GATEWAY_TIMEOUT'))).toEqual({
      message: 'הקובץ לא נטען בזמן. נסו שוב.',
      canRetry: true,
    });
  });

  it('reports a client-side timeout or abort as a timeout, with retry', () => {
    expect(describeAttachmentError(new AttachmentError(0, ATTACHMENT_TIMEOUT_CODE))).toEqual({
      message: 'הקובץ לא נטען בזמן. נסו שוב.',
      canRetry: true,
    });
  });

  it('reports an upstream failure as service unavailable, with retry', () => {
    expect(describeAttachmentError(new AttachmentError(502, 'UPSTREAM_ERROR'))).toEqual({
      message: 'השירות אינו זמין כרגע',
      canRetry: true,
    });
  });

  it.each([401, 403])('reports %s as needing a fresh login, without retry', (status) => {
    expect(describeAttachmentError(new AttachmentError(status, 'UNAUTHORIZED'))).toEqual({
      message: 'יש להתחבר מחדש כדי לצפות בקובץ',
      canRetry: false,
    });
  });

  it('falls back to a generic message for any other status', () => {
    expect(describeAttachmentError(new AttachmentError(500, 'INTERNAL'))).toEqual({
      message: 'לא ניתן לטעון את הקובץ',
      canRetry: true,
    });
  });

  it('falls back to a generic message for an unclassified throw', () => {
    expect(describeAttachmentError(new Error('boom'))).toEqual({
      message: 'לא ניתן לטעון את הקובץ',
      canRetry: true,
    });
    expect(describeAttachmentError(undefined)).toEqual({
      message: 'לא ניתן לטעון את הקובץ',
      canRetry: true,
    });
  });
});

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [15 * 1024 * 1024, '15 MB'],
    [1024 * 1024 * 1024, '1.0 GB'],
  ])('formats %s bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it('returns an empty string for a nonsensical size', () => {
    expect(formatFileSize(Number.NaN)).toBe('');
    expect(formatFileSize(-1)).toBe('');
  });
});
