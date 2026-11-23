import { renderInboxMessage, renderInboxSummary } from './inbox-notify.template';

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
