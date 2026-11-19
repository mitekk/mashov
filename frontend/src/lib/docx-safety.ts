/**
 * Pure guards for the inline `.docx` preview.
 *
 * The preview renders a school's Word file inside this app's origin. The
 * library builds DOM nodes rather than injecting an HTML string, which closes
 * *markup* injection — but not *attribute* injection, and not the strings it
 * interpolates into the stylesheet it generates. These three functions are
 * where that gap is closed. They are pure and total: no DOM, no I/O.
 */

/**
 * Schemes a hyperlink inside a document may navigate to.
 *
 * `docx-preview` assigns `a.href` straight from `word/_rels/document.xml.rels`
 * with no scheme check (`renderHyperlink`), so `javascript:` in a relationship
 * target becomes a clickable anchor in this origin — one tap away from running
 * script with the session cookie attached. Its own stylesheet renders anchors
 * with `color: inherit; text-decoration: inherit`, so such a link does not even
 * look like one.
 *
 * An allowlist, not a `javascript:` denylist: the encodings of a denied scheme
 * are endless, and a scheme nobody anticipated is exactly the failure this is
 * guarding. Relative URLs are refused too — nothing inside an attachment has
 * business navigating this app.
 */
const SAFE_HREF_PATTERN = /^(?:https?:\/\/|mailto:|tel:|#)/i;

export function isSafeDocxHref(href: string): boolean {
  return SAFE_HREF_PATTERN.test((href ?? '').trim());
}

/**
 * Make the generated stylesheet safe to insert.
 *
 * The CSS is machine-assembled but not machine-authored: `parseFont` puts
 * `w:rFonts/@w:ascii` into a declaration, `encloseFontFamily` quotes it only
 * when it contains whitespace, and `styleToString` concatenates without
 * escaping. A font name of `a}*{…}x{y:z` therefore escapes its own block and
 * injects whole rules.
 *
 * Script cannot come from CSS here, so what is actually at stake is the
 * network: a `url()` or `@import` in an injected rule fetches a per-file
 * unique URL from a parent's authenticated session — a read receipt plus IP and
 * user-agent, from a document a school never sent. Both the in-page preview
 * and the print frame insert this text, so both call this.
 *
 * `<` goes as well: it has no legal use in the CSS this library emits, and it
 * is what would close the `<style>` element early and resume in markup.
 */
export function sanitizeDocxCss(css: string): string {
  return (css ?? '')
    .replace(/</g, '')
    .replace(/@import[^;}]*[;}]?/gi, '')
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi,
      (match, doubleQuoted, singleQuoted, bare) => {
        const value = ((doubleQuoted ?? singleQuoted ?? bare ?? '') as string).trim();
        // Embedded images arrive as data: URLs (`useBase64URL`) and are local
        // by construction. Everything else would be a request off this page.
        return /^data:/i.test(value) ? (match as string) : 'none';
      },
    );
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
/** The EOCD record is 22 bytes plus a comment of at most 65535. */
const ZIP_EOCD_MAX_SCAN = 22 + 0xffff;

/**
 * Uncompressed size declared by a zip's central directory — one named entry,
 * or every entry when no name is given. `null` when the bytes are not a
 * readable zip, or when the named entry is absent.
 *
 * Why this exists: `blob.size` is the *compressed* size, and `document.xml` is
 * deflated XML. A 50KB file can hold 15MB of markup and a few hundred thousand
 * runs, each of which becomes a DOM node on the main thread — so a byte cap on
 * the download bounds the transfer and says nothing about the parse. This reads
 * what the archive itself declares, before a single byte is inflated.
 *
 * Callers should name `word/document.xml` rather than take the total: images
 * are separate entries that cost nothing to parse, and a total cap would
 * refuse a legitimate photo-heavy letter while letting a text bomb through.
 *
 * Zip64 entries report `0xffffffff` here; rather than parse the extra field,
 * treat such an archive as unbounded — a Word file that needs zip64 is far past
 * anything this viewer should parse on the main thread anyway.
 */
export function uncompressedDocxSize(
  bytes: ArrayBuffer | Uint8Array,
  entryName?: string,
): number | null {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);

  if (view.byteLength < 22) return null;

  // Scan back for the end-of-central-directory record.
  let eocd = -1;
  const scanFloor = Math.max(0, view.byteLength - ZIP_EOCD_MAX_SCAN);
  for (let offset = view.byteLength - 22; offset >= scanFloor; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let found = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength) return null;
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_SIGNATURE) return null;

    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    if (entryName === undefined) {
      if (uncompressed === 0xffffffff) return Number.POSITIVE_INFINITY;
      total += uncompressed;
    } else {
      const name = decoder.decode(
        new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength),
      );
      if (name === entryName) {
        if (uncompressed === 0xffffffff) return Number.POSITIVE_INFINITY;
        total = uncompressed;
        found = true;
        break;
      }
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (entryName !== undefined && !found) return null;
  return total;
}
