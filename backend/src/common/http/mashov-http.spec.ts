import axios, { AxiosError, CanceledError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import {
  DEFAULT_MASHOV_BASE_URL,
  DEFAULT_MASHOV_TIMEOUT_MS,
  createMashovAxios,
  getMashovProxyConfig,
  isUpstreamUnreachable,
  resolveMashovBaseUrl,
  resolveMashovTimeoutMs,
} from './mashov-http';

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'MASHOV_TIMEOUT_MS'] as const;

describe('mashov-http', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('resolveMashovBaseUrl', () => {
    it('falls back to the default base url when none is configured', () => {
      expect(resolveMashovBaseUrl(undefined)).toBe(DEFAULT_MASHOV_BASE_URL);
    });

    it('falls back to the default base url when configured value is blank', () => {
      expect(resolveMashovBaseUrl('   ')).toBe(DEFAULT_MASHOV_BASE_URL);
    });

    it('uses the configured base url when provided', () => {
      expect(resolveMashovBaseUrl(' https://example.test ')).toBe('https://example.test');
    });
  });

  describe('resolveMashovTimeoutMs', () => {
    it('defaults when MASHOV_TIMEOUT_MS is unset', () => {
      expect(resolveMashovTimeoutMs()).toBe(DEFAULT_MASHOV_TIMEOUT_MS);
    });

    it('uses MASHOV_TIMEOUT_MS when it is a positive number', () => {
      process.env.MASHOV_TIMEOUT_MS = '2500';
      expect(resolveMashovTimeoutMs()).toBe(2500);
    });

    it('ignores a non-numeric MASHOV_TIMEOUT_MS', () => {
      process.env.MASHOV_TIMEOUT_MS = 'soon';
      expect(resolveMashovTimeoutMs()).toBe(DEFAULT_MASHOV_TIMEOUT_MS);
    });

    it('ignores a zero or negative MASHOV_TIMEOUT_MS', () => {
      process.env.MASHOV_TIMEOUT_MS = '0';
      expect(resolveMashovTimeoutMs()).toBe(DEFAULT_MASHOV_TIMEOUT_MS);
      process.env.MASHOV_TIMEOUT_MS = '-1';
      expect(resolveMashovTimeoutMs()).toBe(DEFAULT_MASHOV_TIMEOUT_MS);
    });
  });

  describe('isUpstreamUnreachable', () => {
    it('treats an abort from the timeout signal as unreachable', () => {
      expect(isUpstreamUnreachable(new CanceledError('canceled'))).toBe(true);
    });

    it('treats a connection failure with no response as unreachable', () => {
      const error = new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED');
      expect(isUpstreamUnreachable(error)).toBe(true);
    });

    it('does not treat a 401 from Mashov as unreachable', () => {
      const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
      error.response = { status: 401 } as AxiosError['response'];
      expect(isUpstreamUnreachable(error)).toBe(false);
    });

    it('does not treat a 500 from Mashov as unreachable', () => {
      const error = new AxiosError('Request failed', 'ERR_BAD_RESPONSE');
      error.response = { status: 500 } as AxiosError['response'];
      expect(isUpstreamUnreachable(error)).toBe(false);
    });

    it('does not treat an unrelated error as unreachable', () => {
      expect(isUpstreamUnreachable(new Error('boom'))).toBe(false);
      expect(isUpstreamUnreachable(undefined)).toBe(false);
    });

    it('classifies a real abort produced by the shared factory', async () => {
      process.env.MASHOV_TIMEOUT_MS = '50';
      // 203.0.113.0/24 is reserved for documentation and never routes, so the
      // connect attempt stalls and the signal is what ends the request — the
      // same shape as a blackholed egress proxy.
      const http = createMashovAxios('http://203.0.113.1:9');

      expect.assertions(2);
      try {
        await http.get('/stalls');
      } catch (err) {
        expect(axios.isCancel(err)).toBe(true);
        expect(isUpstreamUnreachable(err)).toBe(true);
      }
    });
  });

  describe('getMashovProxyConfig', () => {
    it('returns no proxy config when HTTPS_PROXY is unset', () => {
      expect(getMashovProxyConfig('https://web.mashov.info')).toEqual({});
    });

    it('returns no proxy config for a non-https base url', () => {
      process.env.HTTPS_PROXY = 'http://proxy.test:3128';
      expect(getMashovProxyConfig('http://web.mashov.info')).toEqual({});
    });

    it('disables axios proxy handling and installs an HttpsProxyAgent', () => {
      process.env.HTTPS_PROXY = 'http://proxy.test:3128';
      const config = getMashovProxyConfig('https://web.mashov.info');
      expect(config.proxy).toBe(false);
      expect(config.httpsAgent).toBeDefined();
    });
  });

  describe('createMashovAxios', () => {
    function runRequestInterceptors(
      instance: ReturnType<typeof createMashovAxios>,
      config: Partial<InternalAxiosRequestConfig>,
    ): InternalAxiosRequestConfig {
      // Axios stores handlers on the interceptor manager; invoke them directly so
      // the interceptor is tested without making a real network request.
      const handlers = (
        instance.interceptors.request as unknown as {
          handlers: Array<{
            fulfilled?: (
              value: InternalAxiosRequestConfig,
            ) => InternalAxiosRequestConfig;
          } | null>;
        }
      ).handlers;

      let result = config as InternalAxiosRequestConfig;
      for (const handler of handlers) {
        if (handler?.fulfilled) {
          result = handler.fulfilled(result);
        }
      }
      return result;
    }

    it('keeps the axios timeout as a second layer', () => {
      const instance = createMashovAxios('https://web.mashov.info');
      expect(instance.defaults.timeout).toBeGreaterThan(0);
    });

    it('attaches an abort signal to every outgoing request', () => {
      const instance = createMashovAxios('https://web.mashov.info');
      const config = runRequestInterceptors(instance, {});
      expect(config.signal).toBeInstanceOf(AbortSignal);
      expect(config.signal?.aborted).toBe(false);
    });

    it('aborts the attached signal once the timeout budget elapses', async () => {
      process.env.MASHOV_TIMEOUT_MS = '20';
      const instance = createMashovAxios('https://web.mashov.info');
      const config = runRequestInterceptors(instance, {});
      const signal = config.signal as AbortSignal;

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(signal.aborted).toBe(true);
    });

    it('does not override a caller-supplied signal', () => {
      const controller = new AbortController();
      const instance = createMashovAxios('https://web.mashov.info');
      const config = runRequestInterceptors(instance, { signal: controller.signal });
      expect(config.signal).toBe(controller.signal);
    });

    it('merges default headers with caller-supplied headers', () => {
      const instance = createMashovAxios('https://web.mashov.info', {
        headers: { 'X-Custom': 'yes' },
      });
      expect(instance.defaults.headers['X-Custom']).toBe('yes');
      expect(instance.defaults.headers.Accept).toContain('application/json');
    });
  });
});
