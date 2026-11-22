import {
  renderInboxMessage,
  renderInboxSummary,
  stripMailHtmlToText,
} from './inbox-notify.template';

const SEND_TIME = new Date('2026-11-17T09:05:00Z');

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

describe('stripMailHtmlToText', () => {
  it('returns an empty string for nothing at all', () => {
    expect(stripMailHtmlToText(null)).toBe('');
    expect(stripMailHtmlToText(undefined)).toBe('');
    expect(stripMailHtmlToText('')).toBe('');
  });

  it('turns block boundaries into line breaks before stripping the tags', () => {
    // Stripping first glues the paragraphs into one run of words:
    // "שלוםנבקש להביא". The replacement has to happen first.
    const text = stripMailHtmlToText('<p>שלום</p><p>נבקש להביא בגדי ספורט</p>');

    expect(text).toBe('שלום\nנבקש להביא בגדי ספורט');
  });

  it.each(['<br>', '<br/>', '<br />', '<BR>'])('breaks a line on %s', (tag) => {
    expect(stripMailHtmlToText(`אחת${tag}שתיים`)).toBe('אחת\nשתיים');
  });

  it('breaks a line on a closing div and a closing list item', () => {
    expect(stripMailHtmlToText('<div>אחת</div><ul><li>שתיים</li><li>שלוש</li></ul>')).toBe(
      'אחת\nשתיים\nשלוש',
    );
  });

  it('drops a script body rather than printing it as text', () => {
    // allowedTags: [] alone keeps the CONTENT of a script tag, which would put
    // JavaScript in a parent's chat as prose.
    const text = stripMailHtmlToText('<p>שלום</p><script>alert(1)</script>');

    expect(text).not.toContain('alert');
    expect(text).toBe('שלום');
  });

  it('decodes the entities Mashov sends rather than showing them raw', () => {
    const text = stripMailHtmlToText('<p>א&nbsp;ב &amp; ג &quot;ד&quot; &#39;ה&#39; &lt;ו&gt;</p>');

    expect(text).toBe('א ב & ג "ד" \'ה\' <ו>');
  });

  it('collapses a run of empty paragraphs into one blank line', () => {
    const text = stripMailHtmlToText('<p>אחת</p><p></p><p>&nbsp;</p><p></p><p>שתיים</p>');

    expect(text).not.toMatch(/\n\s*\n\s*\n/);
    expect(text).toContain('אחת');
    expect(text).toContain('שתיים');
  });

  it('truncates to the budget with an ellipsis', () => {
    const text = stripMailHtmlToText(`<p>${'א'.repeat(1000)}</p>`, 50);

    expect(text.length).toBe(51);
    expect(text.endsWith('…')).toBe(true);
  });

  it('does not add an ellipsis to text that fits', () => {
    expect(stripMailHtmlToText('<p>קצר</p>', 50)).toBe('קצר');
  });
});

describe('renderInboxMessage', () => {
  it('opens with a heading a parent can recognise in a chat list', () => {
    const text = renderInboxMessage(makeMessage(), {});

    expect(text.split('\n')[0]).toBe('דואר חדש מבית הספר');
  });

  it('names the sender and the time it arrived, then the subject', () => {
    const text = renderInboxMessage(makeMessage(), {});

    const lines = text.split('\n');
    expect(lines[1]).toBe('מזכירות בית הספר · 17/11 09:05');
    expect(lines[2]).toBe('יום ספורט ביום חמישי');
  });

  it('includes the body as plain text', () => {
    const text = renderInboxMessage(makeMessage(), {});

    expect(text).toContain('נבקש להביא בגדי ספורט.');
    expect(text).not.toContain('<p>');
  });

  it('falls back to the stored text preview when there is no html body', () => {
    const text = renderInboxMessage(
      makeMessage({ bodyHtmlSanitized: null, bodyTextPreview: 'תזכורת קצרה' }),
      {},
    );

    expect(text).toContain('תזכורת קצרה');
  });

  it('closes with a deep link to the conversation when a base URL is configured', () => {
    const text = renderInboxMessage(makeMessage(), { publicBaseUrl: 'https://mashov.mitya.dev' });

    expect(text.trim().split('\n').pop()).toBe('https://mashov.mitya.dev/inbox/conv-1');
  });

  it('renders no link line at all when no base URL is configured', () => {
    const text = renderInboxMessage(makeMessage(), {});

    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('names a file it is not sending, with the link to open it', () => {
    // Silence would make the message quietly less than the mail it describes.
    const text = renderInboxMessage(makeMessage(), {
      publicBaseUrl: 'https://mashov.mitya.dev',
      unsentFileNames: ['אישור הורים.pdf'],
    });

    expect(text).toContain('קובץ גדול מדי לשליחה: אישור הורים.pdf');
    expect(text).toContain('https://mashov.mitya.dev/inbox/conv-1');
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
    const text = renderInboxMessage(
      makeMessage({ bodyHtmlSanitized: '', bodyTextPreview: null }),
      {},
    );

    expect(text).toContain('יום ספורט ביום חמישי');
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

describe('renderInboxSummary', () => {
  it('counts the messages rather than sending them all', () => {
    const text = renderInboxSummary(9, {});

    expect(text).toContain('9');
    expect(text).toContain('הודעות חדשות');
  });

  it('links to the inbox when a base URL is configured', () => {
    const text = renderInboxSummary(9, { publicBaseUrl: 'https://mashov.mitya.dev' });

    expect(text.trim().split('\n').pop()).toBe('https://mashov.mitya.dev/inbox');
  });

  it('renders no link line at all when no base URL is configured', () => {
    expect(renderInboxSummary(9, {})).not.toMatch(/https?:\/\//);
  });
});
