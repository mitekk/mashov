import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';
import {
  fetchAdminFeedback,
  fetchAdminFeedbackDetail,
  markAdminFeedbackResponded,
} from './adminFeedback';

/**
 * These cover the Cloudflare Access redirect, not the payloads.
 *
 * When the 24h Access session expires, Access answers the admin XHR itself
 * with a 302 to its own login host. Followed, that hop is cross-origin and
 * surfaces as an unreadable "CORS error" — the bug this guard exists for.
 */
function mockFetch(res: Partial<Response>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    type: 'basic',
    json: async () => ({}),
    text: async () => '{}',
    ...res,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function initOf(fetchMock: ReturnType<typeof mockFetch>, index = 0) {
  return fetchMock.mock.calls[index][1] as RequestInit;
}

const OPAQUE_REDIRECT: Partial<Response> = {
  type: 'opaqueredirect',
  status: 0,
  ok: false,
};

describe('admin feedback requests', () => {
  let reload: ReturnType<typeof vi.fn>;
  const realLocation = window.location;

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, href: 'https://mashov.mitya.dev/admin/feedback', reload },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: realLocation,
    });
  });

  it('asks fetch not to follow redirects, so an Access 302 stays readable', async () => {
    const fetchMock = mockFetch({ json: async () => ({ data: [] }) });
    await fetchAdminFeedback('all', 1, 20);
    expect(initOf(fetchMock).redirect).toBe('manual');
    expect(initOf(fetchMock).credentials).toBe('include');
  });

  it.each([
    ['list', () => fetchAdminFeedback()],
    ['detail', () => fetchAdminFeedbackDetail('abc')],
    ['mark responded', () => markAdminFeedbackResponded('abc')],
  ])(
    'hands the browser to Access when %s is answered with a redirect',
    async (_name, call) => {
      mockFetch(OPAQUE_REDIRECT);
      await expect(call()).rejects.toBeInstanceOf(ApiError);
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it('leaves an ordinary 403 to the page and does not navigate', async () => {
    mockFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }),
    });
    await expect(fetchAdminFeedback()).rejects.toMatchObject({ status: 403 });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not change redirect handling for parent-facing calls', async () => {
    const fetchMock = mockFetch({ json: async () => ({ data: null }) });
    await apiFetch('/children');
    expect(initOf(fetchMock).redirect).toBeUndefined();
  });
});
