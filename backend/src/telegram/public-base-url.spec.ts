import { resolvePublicBaseUrl } from './public-base-url';

describe('resolvePublicBaseUrl', () => {
  it.each([undefined, null, '', '   '])('returns null for %p, so no link line is rendered', (raw) => {
    // Fail closed. The alternative is a message containing
    // "undefined/inbox/abc", which is worse than no link at all.
    expect(resolvePublicBaseUrl(raw)).toBeNull();
  });

  it('accepts an https origin', () => {
    expect(resolvePublicBaseUrl('https://mashov.mitya.dev')).toBe('https://mashov.mitya.dev');
  });

  it('strips trailing slashes, so a path can be appended with one slash', () => {
    expect(resolvePublicBaseUrl('https://mashov.mitya.dev///')).toBe('https://mashov.mitya.dev');
  });

  it('trims whitespace that came along from .env', () => {
    expect(resolvePublicBaseUrl('  https://mashov.mitya.dev \n')).toBe('https://mashov.mitya.dev');
  });

  it('accepts http on localhost, which is how the stack runs in development', () => {
    expect(resolvePublicBaseUrl('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it.each([
    'http://mashov.mitya.dev',
    'mashov.mitya.dev',
    '//mashov.mitya.dev',
    'ftp://mashov.mitya.dev',
    'javascript:alert(1)',
    '/inbox',
  ])('refuses %s rather than putting it in a parent’s chat', (raw) => {
    // A link in a Telegram chat is a shared, forwardable artifact. Plain http
    // to a real host would carry a parent's deep link in clear, and anything
    // that is not an origin at all cannot be made into one by appending a path.
    expect(resolvePublicBaseUrl(raw)).toBeNull();
  });

  it('keeps a path-prefixed origin, for a deployment mounted under a subpath', () => {
    expect(resolvePublicBaseUrl('https://example.com/mashov/')).toBe('https://example.com/mashov');
  });
});
