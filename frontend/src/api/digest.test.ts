import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDigestRecipients, updateDigestRecipient } from './digest';

const RECIPIENT = {
  id: 'rec-1',
  userId: 'user-1',
  studentGuid: 'stu-1',
  channel: 'telegram',
  address: '98765',
  displayName: null,
  enabled: true,
  activeFrom: '2026-11-21T10:00:00Z',
  createdAt: '2026-11-21T10:00:00Z',
  updatedAt: '2026-11-21T10:00:00Z',
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

describe('fetchDigestRecipients', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for every subscription without naming a child', async () => {
    // The /more card's question is "what am I subscribed to", so the route is
    // called with no studentGuid at all.
    const fetchMock = mockFetch({ data: [RECIPIENT] });

    const recipients = await fetchDigestRecipients();

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/digest/recipients?limit=100');
    expect(recipients).toEqual([RECIPIENT]);
  });

  it('asks for a page big enough to hold every row the route will return', async () => {
    // The route is paginated per `.claude/rules/api.md`, and its default page
    // is 20. The card is not a paged list -- it is "everything you are
    // subscribed to" -- so a silent truncation at 20 would switch children off
    // in the UI that are still receiving messages. 100 is the route's maximum.
    const fetchMock = mockFetch({
      data: [RECIPIENT],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    await fetchDigestRecipients('stu-1');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/v1/digest/recipients?limit=100&studentGuid=stu-1',
    );
  });
});

describe('updateDigestRecipient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('patches only the enabled flag', async () => {
    const fetchMock = mockFetch({ data: { ...RECIPIENT, enabled: false } });

    const updated = await updateDigestRecipient('rec-1', { enabled: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/v1/digest/recipients/rec-1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ enabled: false });
    expect(updated.enabled).toBe(false);
  });

  it('encodes an id rather than pasting it into the path raw', async () => {
    const fetchMock = mockFetch({ data: RECIPIENT });

    await updateDigestRecipient('a/b', { enabled: true });

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/digest/recipients/a%2Fb');
  });
});
