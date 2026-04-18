import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { MashovSessionService } from './mashov-session.service';
import {
  createMashovAxios,
  resolveMashovBaseUrl,
} from '../common/http/mashov-http';

@Injectable()
export class MashovHttpClient {
  private readonly logger = new Logger(MashovHttpClient.name);
  private readonly httpClient: AxiosInstance;
  private readonly baseUrl = resolveMashovBaseUrl(process.env.MASHOV_BASE_URL);

  constructor(private readonly sessionService: MashovSessionService) {
    this.httpClient = createMashovAxios(this.baseUrl);
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.getResponse<T>(url, config);
    return response.data;
  }

  async getResponse<T>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.requestWithRetryResponse<T>('GET', url, undefined, config);
  }

  async put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.requestWithRetryResponse<T>('PUT', url, data, config);
    return response.data;
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.requestWithRetryResponse<T>('DELETE', url, undefined, config);
    return response.data;
  }

  /**
   * Make a GET request scoped to a specific household connection's credentials.
   * Authenticates using stored encrypted credentials for that connection.
   */
  async getForConnection<T>(
    url: string,
    connectionId: string,
    semel: number,
    year: number,
    username: string,
    password: string,
    config?: AxiosRequestConfig,
    isRetry = false,
  ): Promise<T> {
    const authHeaders = await this.sessionService.getAuthHeadersForConnection(
      connectionId,
      semel,
      year,
      username,
      password,
    );
    const headers = { ...authHeaders, ...(config?.headers ?? {}) };

    try {
      const response = await this.httpClient.get<T>(url, { ...config, headers });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const isAuthError = status === 401 || status === 403;
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        if ((isAuthError || isTimeout) && !isRetry) {
          this.logger.debug(
            `Connection ${connectionId} got ${isTimeout ? 'timeout' : status}, refreshing session and retrying`,
          );
          const refreshedHeaders = await this.sessionService.getAuthHeadersForConnection(
            connectionId,
            semel,
            year,
            username,
            password,
            true,
          );
          const retryHeaders = { ...refreshedHeaders, ...(config?.headers ?? {}) };
          const retryResponse = await this.httpClient.get<T>(url, { ...config, headers: retryHeaders });
          return retryResponse.data;
        }
        const msg = `Upstream GET ${url} (connection ${connectionId}) failed with status ${status ?? 'unknown'}: ${error.message}`;
        throw new Error(msg);
      }
      throw error;
    }
  }

  private async requestWithRetryResponse<T>(
    method: string,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
    isRetry = false,
  ): Promise<AxiosResponse<T>> {
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
      } else if (method === 'DELETE') {
        response = await this.httpClient.delete<T>(url, { ...config, headers });
      } else {
        throw new Error(`Unsupported HTTP method: ${method}`);
      }
      return response;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if ((status === 401 || status === 403) && !isRetry) {
          this.logger.debug(`Received ${status} from upstream, refreshing session and retrying`);
          await this.sessionService.refreshIfExpired();
          return this.requestWithRetryResponse<T>(method, url, data, config, true);
        }
        const msg = `Upstream request ${method} ${url} failed with status ${status ?? 'unknown'}: ${error.message}`;
        throw new Error(msg);
      }
      throw error;
    }
  }
}
