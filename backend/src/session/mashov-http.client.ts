import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { SessionService } from './session.service';

@Injectable()
export class MashovHttpClient {
  private readonly logger = new Logger(MashovHttpClient.name);
  private readonly httpClient: AxiosInstance;
  private readonly baseUrl = 'https://web.mashov.info';

  constructor(private readonly sessionService: SessionService) {
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
    });
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('GET', url, undefined, config);
  }

  async put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('PUT', url, data, config);
  }

  private async requestWithRetry<T>(
    method: string,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
    isRetry = false,
  ): Promise<T> {
    const authHeaders = await this.sessionService.getAuthHeaders();
    const headers = {
      ...authHeaders,
      ...(config?.headers ?? {}),
    };

    try {
      let response: AxiosResponse<T>;
      if (method === 'GET') {
        response = await this.httpClient.get<T>(url, { ...config, headers });
      } else if (method === 'PUT') {
        response = await this.httpClient.put<T>(url, data, { ...config, headers });
      } else {
        throw new Error(`Unsupported HTTP method: ${method}`);
      }
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if ((status === 401 || status === 403) && !isRetry) {
          this.logger.debug(`Received ${status} from upstream, refreshing session and retrying`);
          await this.sessionService.refreshIfExpired();
          return this.requestWithRetry<T>(method, url, data, config, true);
        }
        const msg = `Upstream request ${method} ${url} failed with status ${status ?? 'unknown'}: ${error.message}`;
        throw new Error(msg);
      }
      throw error;
    }
  }
}
