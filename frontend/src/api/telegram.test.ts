import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTelegramLink,
  disconnectTelegram,
  fetchTelegramLinkState,
} from './telegram';

const LINK = {
  code: 'deadbeef',
  deepLink: 'https://t.me/mashov_bot?start=deadbeef',
  botUsername: 'mashov_bot',
  expiresAt: '2026-11-21T10:15:00Z',
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callOf(fetchMock: ReturnType<typeof mockFetch>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index];
  return { url: String(url), init: init as RequestInit };
}

describe('createTelegramLink', () => {
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchMock = mockFetch({ data: LINK }, 201);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the chosen children to the link route', async () => {
    await createTelegramLink(['stu-1', 'stu-2']);

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('/api/v1/digest/telegram-links');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ studentGuids: ['stu-1', 'stu-2'] });
  });

  it('unwraps the data envelope', async () => {
    expect(await createTelegramLink(['stu-1'])).toEqual(LINK);
  });
});

describe('fetchTelegramLinkState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the state of one code', async () => {
    const fetchMock = mockFetch({ data: { status: 'pending' } });

    const state = await fetchTelegramLinkState('deadbeef');

    expect(callOf(fetchMock).url).toBe('/api/v1/digest/telegram-links/deadbeef');
    expect(state.status).toBe('pending');
  });

  it('encodes the code rather than pasting it into the path raw', async () => {
    const fetchMock = mockFetch({ data: { status: 'expired' } });

    await fetchTelegramLinkState('a/b?c');

    expect(callOf(fetchMock).url).toBe('/api/v1/digest/telegram-links/a%2Fb%3Fc');
  });
});

describe('disconnectTelegram', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes every link the caller has', async () => {
    const fetchMock = mockFetch({}, 204);

    await disconnectTelegram();

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('/api/v1/digest/telegram-links');
    expect(init.method).toBe('DELETE');
  });
});
