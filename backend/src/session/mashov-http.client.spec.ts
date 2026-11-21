import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { MashovHttpClient } from './mashov-http.client';
import type { MashovSessionService } from './mashov-session.service';
import type { ConnectionTarget } from './connection-target';

/**
 * The transport is excluded from `collectCoverageFrom`, but these four methods
 * are the only per-connection write path in the app: every mutation and every
 * attachment download routes through them, and the retry they inherit from
 * `getForConnection` is what keeps an expired Mashov session from surfacing as
 * a failed archive. Both are worth asserting directly.
 */

const TARGET: ConnectionTarget = {
  id: 'conn-a',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent-a',
  password: 'pw-a',
  schoolName: 'אורט רמון',
};

interface StubAxios {
  get: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
}

function axiosError(status: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status ?? 'unknown'}`,
    response: status === undefined ? undefined : { status },
    ...extra,
  };
}

function ok<T>(data: T, headers: Record<string, string> = {}): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers,
    config: {} as AxiosRequestConfig as AxiosResponse<T>['config'],
  };
}

function makeClient(): {
  client: MashovHttpClient;
  http: StubAxios;
  getAuthHeadersForConnection: jest.Mock;
} {
  const getAuthHeadersForConnection = jest
    .fn()
    .mockImplementation((_id, _semel, _year, _user, _pw, forceRefresh = false) =>
      Promise.resolve({
        'X-Csrf-Token': forceRefresh ? 'csrf-fresh' : 'csrf-cached',
        Cookie: forceRefresh ? 'MashovAuthToken=fresh' : 'MashovAuthToken=cached',
      }),
    );

  const sessionService = {
    getAuthHeadersForConnection,
    getAuthHeaders: jest.fn().mockResolvedValue({}),
    refreshIfExpired: jest.fn().mockResolvedValue(undefined),
  } as unknown as MashovSessionService;

  const client = new MashovHttpClient(sessionService);
  const http: StubAxios = { get: jest.fn(), put: jest.fn(), delete: jest.fn() };
  // The axios instance is built in the constructor from the real factory; the
  // alternative to replacing it is an HTTP interceptor, which would also test
  // axios.
  (client as unknown as { httpClient: StubAxios }).httpClient = http;

  return { client, http, getAuthHeadersForConnection };
}

describe('MashovHttpClient per-connection transport', () => {
  describe('getForTarget', () => {
    it("sends the connection's auth headers and merges the caller's own", async () => {
      const { client, http, getAuthHeadersForConnection } = makeClient();
      http.get.mockResolvedValue(ok([{ id: 1 }]));

      const data = await client.getForTarget<Array<{ id: number }>>('/api/x', TARGET, {
        headers: { Referer: 'https://web.mashov.info/students/main' },
      });

      expect(data).toEqual([{ id: 1 }]);
      expect(getAuthHeadersForConnection).toHaveBeenCalledWith(
        'conn-a',
        540175,
        2026,
        'parent-a',
        'pw-a',
      );
      const [url, config] = http.get.mock.calls[0] as [string, AxiosRequestConfig];
      expect(url).toBe('/api/x');
      expect(config.headers).toEqual({
        'X-Csrf-Token': 'csrf-cached',
        Cookie: 'MashovAuthToken=cached',
        Referer: 'https://web.mashov.info/students/main',
      });
    });

    it('returns the payload while getResponseForTarget returns the whole response', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue(ok(Buffer.from('pdf'), { 'content-type': 'application/pdf' }));

      const data = await client.getForTarget<Buffer>('/api/file', TARGET);
      const response = await client.getResponseForTarget<Buffer>('/api/file', TARGET, {
        responseType: 'arraybuffer',
      });

      expect(Buffer.isBuffer(data)).toBe(true);
      // An attachment download needs content-type and content-disposition, which
      // `.data` alone cannot carry.
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.status).toBe(200);
    });
  });

  describe('putForTarget and deleteForTarget', () => {
    it('sends the body on PUT and no body on DELETE', async () => {
      const { client, http } = makeClient();
      http.put.mockResolvedValue(ok({ ok: true }));
      http.delete.mockResolvedValue(ok(undefined));

      await client.putForTarget('/api/mail/archive', { conversationIds: ['c1'] }, TARGET);
      await client.deleteForTarget('/api/mail/archive/c1', TARGET);

      const [putUrl, putBody] = http.put.mock.calls[0] as [string, unknown];
      expect(putUrl).toBe('/api/mail/archive');
      expect(putBody).toEqual({ conversationIds: ['c1'] });
      // axios.delete takes (url, config) — a body argument here would be sent as
      // the config and silently drop the auth headers.
      expect(http.delete.mock.calls[0]).toHaveLength(2);
    });

    it('refreshes the session once on a 403 and retries the same method', async () => {
      const { client, http, getAuthHeadersForConnection } = makeClient();
      http.put.mockRejectedValueOnce(axiosError(403)).mockResolvedValueOnce(ok({ ok: true }));

      await expect(
        client.putForTarget('/api/mail/archive', { ids: ['c1'] }, TARGET),
      ).resolves.toEqual({ ok: true });

      expect(http.put).toHaveBeenCalledTimes(2);
      expect(getAuthHeadersForConnection).toHaveBeenLastCalledWith(
        'conn-a',
        540175,
        2026,
        'parent-a',
        'pw-a',
        true,
      );
      const [, , retryConfig] = http.put.mock.calls[1] as [string, unknown, AxiosRequestConfig];
      expect(retryConfig.headers).toMatchObject({ 'X-Csrf-Token': 'csrf-fresh' });
    });

    it('throws naming the method when the retry also fails', async () => {
      const { client, http } = makeClient();
      http.put.mockRejectedValue(axiosError(403));

      await expect(
        client.putForTarget('/api/mail/archive', { ids: ['c1'] }, TARGET),
      ).rejects.toThrow(/Upstream PUT \/api\/mail\/archive \(connection conn-a\) failed with status 403/);
      expect(http.put).toHaveBeenCalledTimes(2);
    });

    it('retries once on a timeout', async () => {
      const { client, http } = makeClient();
      http.delete
        .mockRejectedValueOnce(axiosError(undefined, { code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' }))
        .mockResolvedValueOnce(ok({ ok: true }));

      await expect(client.deleteForTarget('/api/x', TARGET)).resolves.toEqual({ ok: true });
      expect(http.delete).toHaveBeenCalledTimes(2);
    });

    it('does not retry a cancellation', async () => {
      // The shared AbortSignal from createMashovAxios rejects with ERR_CANCELED
      // when the egress path stalls. Retrying into a blackholed proxy doubles
      // the stall. See ADR-0023 — this must stay un-retried.
      const { client, http, getAuthHeadersForConnection } = makeClient();
      http.get.mockRejectedValue(axiosError(undefined, { code: 'ERR_CANCELED', message: 'canceled' }));

      await expect(client.getForTarget('/api/x', TARGET)).rejects.toThrow(/Upstream GET/);

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(getAuthHeadersForConnection).toHaveBeenCalledTimes(1);
      expect(getAuthHeadersForConnection).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        true,
      );
    });
  });

  describe('getForConnection', () => {
    it('still works through its positional signature', async () => {
      // The ~16 sync tasks call this shape. It must keep working untouched in
      // this task, or every one of them has to change in the same commit.
      const { client, http, getAuthHeadersForConnection } = makeClient();
      http.get.mockResolvedValue(ok([{ lessonId: 7 }]));

      const data = await client.getForConnection<Array<{ lessonId: number }>>(
        '/api/homework',
        'conn-a',
        540175,
        2026,
        'parent-a',
        'pw-a',
        { headers: { Referer: 'x' } },
      );

      expect(data).toEqual([{ lessonId: 7 }]);
      expect(getAuthHeadersForConnection).toHaveBeenCalledWith(
        'conn-a',
        540175,
        2026,
        'parent-a',
        'pw-a',
      );
      const [url] = http.get.mock.calls[0] as [string];
      expect(url).toBe('/api/homework');
    });
  });
});
