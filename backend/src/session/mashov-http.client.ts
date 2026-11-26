import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { MashovSessionService } from './mashov-session.service';
import type { ConnectionTarget } from './connection-target';
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

  /**
   * Make a GET request scoped to a specific household connection's credentials.
   * Authenticates using stored encrypted credentials for that connection.
   *
   * Kept at its original positional signature: roughly sixteen sync tasks call
   * it this way, and collapsing them onto `ConnectionTarget` is a separate
   * change from making PUT, DELETE and raw responses reachable at all.
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
    const response = await this.requestForConnection<T>(
      'GET',
      url,
      undefined,
      {
        id: connectionId,
        schoolCode: semel,
        schoolYear: year,
        username,
        password,
        schoolName: null,
      },
      config,
      isRetry,
    );
    return response.data;
  }

  /** GET as one connection, returning the payload. */
  async getForTarget<T>(
    url: string,
    target: ConnectionTarget,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.requestForConnection<T>('GET', url, undefined, target, config);
    return response.data;
  }

  /**
   * GET as one connection, returning the whole response.
   *
   * Attachment downloads need `content-type` and `content-disposition` to name
   * and serve the file, and `.data` alone cannot carry them.
   */
  async getResponseForTarget<T>(
    url: string,
    target: ConnectionTarget,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.requestForConnection<T>('GET', url, undefined, target, config);
  }

  /** PUT as one connection. */
  async putForTarget<T>(
    url: string,
    data: unknown,
    target: ConnectionTarget,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.requestForConnection<T>('PUT', url, data, target, config);
    return response.data;
  }

  /** DELETE as one connection. */
  async deleteForTarget<T>(
    url: string,
    target: ConnectionTarget,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.requestForConnection<T>('DELETE', url, undefined, target, config);
    return response.data;
  }

  /**
   * One request as one connection, with the single session-refresh retry.
   *
   * The retry is why every per-connection call has to come through here: a
   * Mashov session expires on its own schedule, so a mutation that does not
   * refresh and retry surfaces an expired cookie to the user as a failed
   * archive or a failed consent reply.
   */
  private async requestForConnection<T>(
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    data: unknown,
    target: ConnectionTarget,
    config?: AxiosRequestConfig,
    isRetry = false,
  ): Promise<AxiosResponse<T>> {
    const { id: connectionId, schoolCode, schoolYear, username, password } = target;

    const authHeaders = await this.sessionService.getAuthHeadersForConnection(
      connectionId,
      schoolCode,
      schoolYear,
      username,
      password,
    );
    const headers = { ...authHeaders, ...(config?.headers ?? {}) };

    try {
      return await this.send<T>(method, url, data, { ...config, headers });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const isAuthError = status === 401 || status === 403;
        // Deliberately does NOT match the shared AbortSignal bound from
        // createMashovAxios, which rejects with ERR_CANCELED / "canceled":
        // that abort means the egress path is stalled, and retrying into a
        // blackholed proxy only doubles the stall. Do not "fix" this by
        // adding axios.isCancel() here. See ADR-0023.
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        if ((isAuthError || isTimeout) && !isRetry) {
          this.logger.debug(
            `Connection ${connectionId} got ${isTimeout ? 'timeout' : status}, refreshing session and retrying`,
          );
          const refreshedHeaders = await this.sessionService.getAuthHeadersForConnection(
            connectionId,
            schoolCode,
            schoolYear,
            username,
            password,
            true,
          );
          const retryHeaders = { ...refreshedHeaders, ...(config?.headers ?? {}) };
          try {
            return await this.send<T>(method, url, data, { ...config, headers: retryHeaders });
          } catch (retryError) {
            // The original let a failed retry escape as the raw axios error,
            // so the same upstream failure reached callers in two different
            // shapes depending on whether it happened before or after the
            // session refresh. No caller inspects the error type, and every one
            // of them logs `error.message`, so the tidy message is strictly
            // better than an AxiosError's own.
            throw new Error(this.describeFailure(method, url, connectionId, retryError));
          }
        }
        throw new Error(this.describeFailure(method, url, connectionId, error));
      }
      throw error;
    }
  }

  private describeFailure(
    method: string,
    url: string,
    connectionId: string,
    error: unknown,
  ): string {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return `Upstream ${method} ${url} (connection ${connectionId}) failed with status ${status ?? 'unknown'}: ${detail}`;
  }

  /**
   * The shared request primitive. Not part of the retired env-credential
   * surface: `requestForConnection` builds the per-connection auth headers and
   * then dispatches through here.
   */
  private async send<T>(
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    data: unknown,
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    if (method === 'GET') return this.httpClient.get<T>(url, config);
    if (method === 'PUT') return this.httpClient.put<T>(url, data, config);
    // axios.delete takes (url, config): passing a body here would be read as
    // the config and silently drop the auth headers.
    return this.httpClient.delete<T>(url, config);
  }
}
