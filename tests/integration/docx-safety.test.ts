/**
 * Unit tests for the pure guards the inline `.docx` preview relies on.
 *
 * These are the parts of the docx path that are *not* covered by e2e: the
 * three functions below decide whether a crafted Word file can reach a
 * navigable `javascript:` URL, an outbound CSS request, or an unbounded parse.
 * Same placement rationale as `attachment-helpers.test.ts` — pure functions in
 * the root jest project, because the frontend has no test runner.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import {
  isSafeDocxHref,
  sanitizeDocxCss,
  uncompressedDocxSize,
} from '@/lib/docx-safety';

describe('isSafeDocxHref', () => {
  it.each(['https://example.com/form', 'http://example.com', 'mailto:a@b.c', 'tel:+972501234567', '#bookmark'])(
    'allows %s',
    (href) => {
      expect(isSafeDocxHref(href)).toBe(true);
    },
  );

  it('refuses javascript: — the vector a crafted hyperlink relationship carries', () => {
    // `docx-preview` assigns `a.href` straight from word/_rels/document.xml.rels
    // with no scheme check, and the preview is in this app's origin.
    expect(isSafeDocxHref('javascript:alert(1)')).toBe(false);
    expect(isSafeDocxHref('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeDocxHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeDocxHref('java\nscript:alert(1)')).toBe(false);
  });

  it.each(['data:text/html,<script>x</script>', 'vbscript:msgbox', 'file:///etc/passwd', 'blob:https://x/y', ''])(
    'refuses %s',
    (href) => {
      expect(isSafeDocxHref(href)).toBe(false);
    },
  );

  it('refuses a relative URL — nothing in a docx should navigate this app', () => {
    expect(isSafeDocxHref('/api/v1/mail')).toBe(false);
    expect(isSafeDocxHref('form.docx')).toBe(false);
  });
});

describe('sanitizeDocxCss', () => {
  it('drops a url() that would call out to a third party', () => {
    // A font name with no whitespace is not quoted by the library, so it
    // escapes its declaration block and injects whole rules.
    const injected =
      "font-family: a}*{background-image:url(https://evil.example/beacon.png)}x{y:z;";
    const result = sanitizeDocxCss(injected);
    expect(result).not.toContain('evil.example');
    expect(result).toContain('background-image:none');
  });

  it.each([
    'url(https://evil.example/x.png)',
    "url('https://evil.example/x.png')",
    'url( "https://evil.example/x.png" )',
    'url(//evil.example/x.png)',
    'URL(HTTPS://EVIL.EXAMPLE/x.png)',
  ])('drops %s in any spelling', (snippet) => {
    expect(sanitizeDocxCss(`a{background:${snippet}}`)).not.toContain('evil');
  });

  it('keeps a data: url, which is what embedded images become', () => {
    const css = 'a{background:url(data:image/png;base64,iVBORw0KGgo=)}';
    expect(sanitizeDocxCss(css)).toBe(css);
  });

  it('drops @import, which would fetch a remote stylesheet', () => {
    expect(sanitizeDocxCss('@import url("https://evil.example/x.css");a{b:c}')).not.toContain(
      'evil.example',
    );
  });

  it('strips < so a style name cannot close the element it sits in', () => {
    expect(sanitizeDocxCss('a{b:c}</style><script>x</script>')).not.toContain('<');
  });

  it('leaves ordinary generated css alone', () => {
    const css = '.docx p { margin: 0pt; min-height: 1em; }';
    expect(sanitizeDocxCss(css)).toBe(css);
  });
});

describe('uncompressedDocxSize', () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, '..', 'e2e', 'fixtures', 'sample.docx'),
  );

  it('reads the real fixture total from the zip central directory', () => {
    const size = uncompressedDocxSize(fixture);
    expect(size).toBeGreaterThan(fixture.length);
    expect(size).toBeLessThan(100 * 1024);
  });

  it('sees through compression — a bomb is small on the wire and huge in the DOM', () => {
    // 2MB of one repeated byte deflates to a few KB. `blob.size` cannot tell
    // this apart from an ordinary small document; the central directory can.
    const bomb = makeZip('word/document.xml', Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(uncompressedDocxSize(bomb)).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  });

  it('reads one named entry, which is what the parse cost actually tracks', () => {
    // Images are separate entries and cost nothing to *parse*; `document.xml`
    // is what becomes hundreds of thousands of DOM nodes. Capping the total
    // would refuse a legitimate photo-heavy letter.
    const bomb = makeZip('word/document.xml', Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(uncompressedDocxSize(bomb, 'word/document.xml')).toBeGreaterThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(uncompressedDocxSize(bomb, 'word/missing.xml')).toBeNull();
    expect(uncompressedDocxSize(fixture, 'word/document.xml')).toBeGreaterThan(400);
  });

  it('returns null for bytes that are not a zip at all', () => {
    expect(uncompressedDocxSize(Buffer.from('PK\u0003\u0004 not really a docx'))).toBeNull();
    expect(uncompressedDocxSize(Buffer.alloc(0))).toBeNull();
  });
});

/** Minimal deflate-compressed zip, so the bomb test needs no fixture file. */
function makeZip(name: string, contents: Buffer): Buffer {
  const deflated = zlib.deflateRawSync(contents);
  const nameBytes = Buffer.from(name, 'utf-8');
  const crc = 0; // not validated by the size reader

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);

  const localPart = Buffer.concat([local, nameBytes, deflated]);
  const centralPart = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}
