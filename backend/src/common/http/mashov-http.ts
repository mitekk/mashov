import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const DEFAULT_MASHOV_BASE_URL = 'https://web.mashov.info';

/**
 * Wall-clock budget for a single Mashov request, enforced with an AbortSignal.
 *
 * Axios' own `timeout` is armed via `req.setTimeout()`, which only starts
 * counting once a socket is assigned. `HttpsProxyAgent` defers socket
 * assignment until its CONNECT completes, so when the egress proxy blackholes
 * (a dead tailnet node drops packets instead of refusing them) the axios
 * timeout never arms and the request hangs indefinitely. An AbortSignal starts
 * counting immediately and is the only mechanism that bounds this.
 *
 * Note: `new HttpsProxyAgent(url, { timeout })` was measured and does NOT bound
 * the TCP connect — do not reach for it as a substitute.
 */
export const DEFAULT_MASHOV_TIMEOUT_MS = 10000;

const DEFAULT_MASHOV_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

function resolveHttpsProxyUrl(): string | undefined {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxyUrl) {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveMashovBaseUrl(configuredUrl?: string): string {
  const trimmed = configuredUrl?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MASHOV_BASE_URL;
}

/**
 * Wall-clock budget for Mashov requests, overridable with `MASHOV_TIMEOUT_MS`.
 * Read per request so the value can be tuned without a restart of the process
 * that built the axios instance.
 */
export function resolveMashovTimeoutMs(): number {
  const raw = process.env.MASHOV_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_MASHOV_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MASHOV_TIMEOUT_MS;
}

/**
 * True when a request failed without ever getting a response from Mashov —
 * an abort from the signal above, a refused/blackholed proxy, a DNS failure.
 *
 * Callers must not report these as credential failures: the user's password is
 * not what went wrong, and telling them it was sends them round a loop of
 * retyping it during an upstream outage.
 */
export function isUpstreamUnreachable(error: unknown): boolean {
  if (axios.isCancel(error)) {
    return true;
  }
  return axios.isAxiosError(error) && error.response === undefined;
}

export function getMashovProxyConfig(
  baseUrl: string,
): Pick<AxiosRequestConfig, 'proxy' | 'httpsAgent'> {
  const httpsProxyUrl = resolveHttpsProxyUrl();
  if (!httpsProxyUrl || !baseUrl.startsWith('https://')) {
    return {};
  }
  return {
    proxy: false,
    httpsAgent: new HttpsProxyAgent(httpsProxyUrl),
  };
}

export function createMashovAxios(
  baseUrl: string,
  config: AxiosRequestConfig = {},
): AxiosInstance {
  const mergedHeaders = {
    ...DEFAULT_MASHOV_HEADERS,
    ...(config.headers ?? {}),
  };

  const instance = axios.create({
    baseURL: baseUrl,
    // Derived from the same knob as the signal below, so raising
    // MASHOV_TIMEOUT_MS past a hard-coded ceiling cannot leave this layer
    // silently cutting the request short first.
    timeout: resolveMashovTimeoutMs(),
    ...getMashovProxyConfig(baseUrl),
    ...config,
    headers: mergedHeaders,
  });

  // Primary bound. `timeout` above stays as a second layer for the cases where
  // a socket does get assigned.
  instance.interceptors.request.use((requestConfig) => {
    requestConfig.signal ??= AbortSignal.timeout(resolveMashovTimeoutMs());
    return requestConfig;
  });

  return instance;
}
