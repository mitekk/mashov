import { describe, expect, it } from 'vitest';
import { safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('falls back to the app entry point when there is no next', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('   ')).toBe('/');
  });

  it('keeps the parent-facing routes middleware can put in next', () => {
    expect(safeNextPath('/home')).toBe('/home');
    expect(safeNextPath('/home?x=1#y')).toBe('/home?x=1#y');
    expect(safeNextPath('/children/abc')).toBe('/children/abc');
    expect(safeNextPath('/inbox/42')).toBe('/inbox/42');
    expect(safeNextPath('/more')).toBe('/more');
    expect(safeNextPath('/more/telegram')).toBe('/more/telegram');
  });

  it('refuses to send the browser off-site', () => {
    // The open redirect this helper exists to close: the sign-in page used to
    // push `next` straight into the router.
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('http://evil.com/home')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('home')).toBe('/');
  });

  it('refuses internal routes that are not a parent destination', () => {
    // /auth/* would bounce the parent back to the page they just left, and
    // /admin is the operator surface behind Cloudflare Access.
    expect(safeNextPath('/auth/sign-in')).toBe('/');
    expect(safeNextPath('/auth/syncing')).toBe('/');
    expect(safeNextPath('/admin/feedback')).toBe('/');
  });
});
