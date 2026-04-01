import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const DEFAULT_MASHOV_BASE_URL = 'https://web.mashov.info';

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

  return axios.create({
    baseURL: baseUrl,
    timeout: 30000,
    ...getMashovProxyConfig(baseUrl),
    ...config,
    headers: mergedHeaders,
  });
}
