import { renderInboxMessage, renderInboxSummary } from './inbox-notify.template';
import { TELEGRAM_CHUNK_LIMIT } from '../telegram/telegram-http';
import { stripTelegramHtml } from '../telegram/telegram-html';

const SEND_TIME = new Date('2026-11-17T09:05:00Z');
const BASE = 'https://mashov.mitya.dev';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderName: 'מזכירות בית הספר',
    subject: 'יום ספורט ביום חמישי',
    bodyHtmlSanitized: '<p>שלום,</p><p>נבקש להביא בגדי ספורט.</p>',
    bodyTextPreview: null as string | null,
    sendTime: SEND_TIME,
    ...overrides,
  };
}

describe('renderInboxMessage', () => {
  it('opens with a bold heading a parent can recognise in a chat list', () => {
    const text = renderInboxMessage(makeMessage(), {});

    expect(text.split('\n')[0]).toBe('📬 <b>דואר חדש מבית הספר</b>');
  });

  it('names the sender and the time as an italic meta line, then the subject in bold', () => {
    const text = renderInboxMessage(makeMessage(), {});

    const lines = text.split('\n');
    expect(lines[1]).toBe('<i>מזכירות בית הספר · 17/11 09:05</i>');
    expect(lines[2]).toBe('<b>יום ספורט ביום חמישי</b>');
  });

  it("quotes the body, because they are the school's own words", () => {
    const text = renderInboxMessage(makeMessage(), {});

    // Both paragraphs on one line: a blockquote spanning two lines is exactly
    // what the chunker's hard cut could split.
    expect(text).toContain('<blockquote>שלום,</blockquote>');
    expect(text).toContain('<blockquote>נבקש להביא בגדי ספורט.</blockquote>');
    expect(text).not.toContain('<p>');
  });

  it('falls back to the stored text preview when there is no html body', () => {
    const text = renderInboxMessage(
      makeMessage({ bodyHtmlSanitized: null, bodyTextPreview: 'תזכורת קצרה' }),
      {},
    );

    expect(text).toContain('<blockquote>תזכורת קצרה</blockquote>');
  });

  it('writes no model prose at all, only the structure around the school text', () => {
    // Deliberately model-free: the school wrote the mail, and a summary of it
    // is a second-hand account of something the parent can read verbatim.
    const text = renderInboxMessage(makeMessage(), {});

    expect(stripTelegramHtml(text)).toContain('נבקש להביא בגדי ספורט.');
  });

  it('anchors the link on words rather than printing the URL', () => {
    const text = renderInboxMessage(makeMessage(), { publicBaseUrl: BASE });

    expect(text).toContain(`<a href="${BASE}/inbox/conv-1">לפתוח את ההודעה</a>`);
    for (const line of text.split('\n')) {
      expect(line.replace(/href="[^"]*"/g, '')).not.toContain('http');
    }
  });

  it('renders no link line at all when no base URL is configured', () => {
    const text = renderInboxMessage(makeMessage(), {});

    expect(text).not.toContain('undefined');
    expect(text).not.toContain('<a href');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('names a file it is not sending, with the link to open it', () => {
    const text = renderInboxMessage(makeMessage(), {
      publicBaseUrl: BASE,
      unsentFileNames: ['אישור הורים.pdf'],
    });

    expect(text).toContain('📎');
    expect(text).toContain('קובץ גדול מדי לשליחה: אישור הורים.pdf');
    expect(text).toContain(`${BASE}/inbox/conv-1`);
  });

  it('still names the file when there is no site to link to', () => {
    const text = renderInboxMessage(makeMessage(), { unsentFileNames: ['אישור.pdf'] });

    expect(text).toContain('קובץ גדול מדי לשליחה: אישור.pdf');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('never includes the recipients list', () => {
    // A school mail's recipients name every other parent in the class.
    const text = renderInboxMessage(makeMessage(), {});

    expect(text).not.toContain('recipients');
  });

  it('still sends something when the body is empty', () => {
    const text = renderInboxMessage(makeMessage({ bodyHtmlSanitized: '', bodyTextPreview: null }), {});

    expect(text).toContain('יום ספורט ביום חמישי');
    expect(text).not.toContain('<blockquote>');
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('escapes the three reserved characters in a subject, sender and body', () => {
    // All three are the school's text, and all three are untrusted here.
    const text = renderInboxMessage(
      makeMessage({
        senderName: 'כיתה ג<2> & ד',
        subject: 'ציונים <סופיים> & מעודכנים',
        bodyHtmlSanitized: null,
        bodyTextPreview: 'נא לאשר <עד> מחר & תודה',
      }),
      {},
    );

    expect(text).toContain('כיתה ג&lt;2&gt; &amp; ד');
    expect(text).toContain('ציונים &lt;סופיים&gt; &amp; מעודכנים');
    expect(text).toContain('נא לאשר &lt;עד&gt; מחר &amp; תודה');
    expect(text).not.toContain('<סופיים>');
  });

  it('escapes a hostile filename', () => {
    const text = renderInboxMessage(makeMessage(), { unsentFileNames: ['<b>x</b> & y.pdf'] });

    expect(text).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y.pdf');
  });

  it('renders no line longer than the chunk limit', () => {
    // The invariant that keeps the chunker's hard cut away from a tag: mail
    // bodies are already budgeted by DEFAULT_BODY_CHARS, and everything else
    // interpolated here is clamped.
    const long = 'א'.repeat(9000);
    const text = renderInboxMessage(
      makeMessage({
        senderName: long,
        subject: long,
        bodyHtmlSanitized: null,
        bodyTextPreview: long,
      }),
      { publicBaseUrl: BASE, unsentFileNames: [long] },
    );

    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
  });

  it('keeps the paragraphs of a multi-paragraph letter apart, one quote each', () => {
    // `html-to-text` goes to documented trouble to preserve paragraph breaks
    // (the "שלוםנבקש להביא" comment). Collapsing them into one line to satisfy
    // the one-line-per-tag invariant threw that away and made a school letter
    // read as a run-on block -- in the one feature whose point is that a
    // message scans in two seconds. One blockquote per paragraph keeps both.
    const text = renderInboxMessage(
      makeMessage({ bodyHtmlSanitized: '<p>שורה א</p><p>שורה ב</p><p>שורה ג</p>' }),
      {},
    );

    expect(text).toContain('<blockquote>שורה א</blockquote>');
    expect(text).toContain('<blockquote>שורה ב</blockquote>');
    expect(text).toContain('<blockquote>שורה ג</blockquote>');
    // And the invariant still holds: every tag opens and closes in one line.
    for (const line of text.split('\n')) {
      expect((line.match(/<[a-z]/g) ?? []).length).toBe((line.match(/<\//g) ?? []).length);
    }
  });
});

describe('renderInboxSummary', () => {
  it('counts the messages rather than sending them all', () => {
    const text = renderInboxSummary(9, {});

    expect(text).toContain('9');
    expect(text).toContain('הודעות חדשות');
    expect(text).toContain('📬');
  });

  it('anchors the link on words rather than printing the URL', () => {
    const text = renderInboxSummary(9, { publicBaseUrl: BASE });

    expect(text).toContain(`<a href="${BASE}/inbox">`);
    expect(text.replace(/href="[^"]*"/g, '')).not.toContain('http');
  });

  it('renders no link line at all when no base URL is configured', () => {
    expect(renderInboxSummary(9, {})).not.toMatch(/https?:\/\//);
  });
});
