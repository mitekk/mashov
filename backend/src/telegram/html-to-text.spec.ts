import { stripMailHtmlToText } from './html-to-text';

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

