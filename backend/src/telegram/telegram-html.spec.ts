import {
  TELEGRAM_LINE_BUDGET,
  clampLine,
  escapeTelegramHtml,
  looksLikeParseFailure,
  stripTelegramHtml,
} from './telegram-html';

describe('escapeTelegramHtml', () => {
  it('escapes the three characters the Bot API reserves', () => {
    expect(escapeTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('leaves a teacher remark readable while neutralising its markup', () => {
    // A remark containing real tags must ARRIVE, visibly, rather than cost the
    // parent the whole message to a parse rejection.
    expect(escapeTelegramHtml('הגיש <b>בזמן</b> & בסדר')).toBe(
      'הגיש &lt;b&gt;בזמן&lt;/b&gt; &amp; בסדר',
    );
  });

  it('does not touch quotes, asterisks, underscores or dots', () => {
    // Unlike Markdown, HTML parse mode cares about none of these -- which is
    // the whole reason this project can use it at all.
    expect(escapeTelegramHtml('"עד 5.11" — *חשוב* _מאוד_ (סוף)')).toBe(
      '"עד 5.11" — *חשוב* _מאוד_ (סוף)',
    );
  });

  it('escapes an ampersand that already looks like an entity, so it cannot be re-parsed', () => {
    expect(escapeTelegramHtml('&amp;')).toBe('&amp;amp;');
  });

  it('renders a non-string input as empty rather than "undefined"', () => {
    expect(escapeTelegramHtml(undefined as unknown as string)).toBe('');
    expect(escapeTelegramHtml(null as unknown as string)).toBe('');
  });
});

describe('stripTelegramHtml', () => {
  it('removes the tags and keeps the text', () => {
    expect(stripTelegramHtml('<b>כותרת</b>\n<blockquote>הערה</blockquote>')).toBe(
      'כותרת\nהערה',
    );
  });

  it('keeps an anchor label and drops the markup around it', () => {
    expect(stripTelegramHtml('• <a href="https://x/children/g/homework/1">חשבון — דף 42</a>')).toBe(
      '• חשבון — דף 42',
    );
  });

  it('turns the three entities back into characters', () => {
    expect(stripTelegramHtml('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });

  it('round-trips escaped text exactly, so the fallback shows what the parent should have seen', () => {
    const remark = 'הגיש <b>בזמן</b> & בסדר';
    expect(stripTelegramHtml(escapeTelegramHtml(remark))).toBe(remark);
  });

  it('is identity on text that carries no markup at all', () => {
    // With TELEGRAM_HTML_ENABLED=false the sender strips every message, so a
    // plain one must come out unchanged.
    expect(stripTelegramHtml('עדכון יומי · 26/11/2025')).toBe('עדכון יומי · 26/11/2025');
  });

  it('decodes entities that were inside a tag-stripped region without re-opening a tag', () => {
    // &lt;b&gt; must decode to visible <b>, not to markup the next parse reads.
    expect(stripTelegramHtml('<b>&lt;b&gt;</b>')).toBe('<b>');
  });
});

describe('clampLine', () => {
  it('collapses a multi-line value into one line', () => {
    // The chunker's hard cut is the only tag-unsafe cut it makes, and it is
    // only reachable inside a line. Every tag therefore has to open and close
    // within one line, so nothing a template interpolates may carry a newline.
    expect(clampLine('שורה ראשונה\nשורה שנייה\n\nשלישית')).toBe(
      'שורה ראשונה שורה שנייה שלישית',
    );
  });

  it('collapses tabs and runs of spaces too', () => {
    expect(clampLine('  חשבון \t\t דף   42  ')).toBe('חשבון דף 42');
  });

  it('keeps a short line untouched', () => {
    expect(clampLine('חשבון — דף 42')).toBe('חשבון — דף 42');
  });

  it('cuts an over-long line to the budget and marks the cut', () => {
    const clamped = clampLine('א'.repeat(2000), 100);
    expect(clamped.length).toBe(100);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('measures the budget AFTER escaping, so an ampersand-dense line still fits', () => {
    // escapeTelegramHtml turns one & into five characters. A budget checked
    // before escaping would admit a line five times over the limit, which is
    // exactly the invariant the chunker depends on.
    const clamped = clampLine('&'.repeat(500), 100);
    expect(escapeTelegramHtml(clamped).length).toBeLessThanOrEqual(100);
  });

  it('never cuts between the halves of a surrogate pair', () => {
    // A lone surrogate renders as a replacement character in the chat.
    for (let budget = 4; budget < 40; budget += 1) {
      const clamped = clampLine('👍'.repeat(50), budget);
      expect(clamped).toBe([...clamped].join(''));
      expect(/[\ud800-\udbff]$/.test(clamped.replace(/…$/, ''))).toBe(false);
    }
  });

  it('returns an empty string for blank or missing input', () => {
    expect(clampLine('   \n  ')).toBe('');
    expect(clampLine(undefined as unknown as string)).toBe('');
  });

  it('defaults to a budget that leaves a rendered line well inside the chunk limit', () => {
    expect(TELEGRAM_LINE_BUDGET).toBeGreaterThan(200);
    expect(TELEGRAM_LINE_BUDGET).toBeLessThan(2000);
    expect(escapeTelegramHtml(clampLine('ב'.repeat(9000))).length).toBeLessThanOrEqual(
      TELEGRAM_LINE_BUDGET,
    );
  });
});

describe('looksLikeParseFailure', () => {
  it.each([
    "Bad Request: can't parse entities: Unsupported start tag \"foo\" at byte offset 12",
    'Bad Request: can\'t parse entities: Unclosed start tag at byte offset 3',
    'Bad Request: Unsupported start tag "3" at byte offset 7',
    'Telegram send failed: can\'t parse ENTITIES',
  ])('recognises %s as a parse complaint worth retrying flat', (description) => {
    expect(looksLikeParseFailure(description)).toBe(true);
  });

  it.each([
    'Bad Request: chat not found',
    'Forbidden: bot was blocked by the user',
    'Too Many Requests: retry after 30',
    'HTTP 502',
    '',
  ])('does not treat %s as a parse complaint', (description) => {
    // A transient failure must stay a failure: retrying it as plain text would
    // report success for a message that never arrived.
    expect(looksLikeParseFailure(description)).toBe(false);
  });
});
