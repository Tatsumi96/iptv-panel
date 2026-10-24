import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

export interface HttpClientOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxContentLength?: number;
  headers?: Record<string, string>;
}

/**
 * Shared outbound HTTP client factory.
 *
 * Hardened for a gateway that must survive a hostile upstream:
 *  - hard timeouts (connect + response),
 *  - a global agent with sane keep-alive and socket limits,
 *  - optional size cap on responses.
 */
@Injectable()
export class HttpClientFactory {
  private readonly logger = new Logger(HttpClientFactory.name);

  create(options: HttpClientOptions = {}): AxiosInstance {
    const instance = axios.create({
      timeout: options.timeoutMs ?? 15_000,
      maxRedirects: options.maxRedirects ?? 5,
      maxContentLength: options.maxContentLength ?? 64 * 1024 * 1024,
      maxBodyLength: options.maxContentLength ?? 64 * 1024 * 1024,
      headers: {
        'User-Agent': 'IPTV-Home-Gateway/1.0',
        ...options.headers,
      },
      // Never let a 4xx/5xx throw by default: the callers decide.
      validateStatus: () => true,
      httpAgent: new (require('node:http').Agent)({
        keepAlive: true,
        maxSockets: 64,
        maxFreeSockets: 16,
        timeout: options.timeoutMs ?? 15_000,
      }),
      httpsAgent: new (require('node:https').Agent)({
        keepAlive: true,
        maxSockets: 64,
        maxFreeSockets: 16,
        timeout: options.timeoutMs ?? 15_000,
      }),
    });

    instance.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logger.warn(
          `Requete HTTP echouee: ${error?.code ?? ''} ${error?.message ?? ''}`,
        );
        return Promise.reject(error);
      },
    );

    return instance;
  }

  /** Absolute URL join helper tolerant to missing/extra slashes. */
  buildUrl(baseUrl: string, path: string, params?: Record<string, unknown>): string {
    const base = baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${base}${suffix}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  get<T = unknown>(
    instance: AxiosInstance,
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<{ status: number; data: T; headers: Record<string, unknown> }> {
    return instance
      .get<T>(url, config)
      .then((response) => ({
        status: response.status,
        data: response.data,
        headers: response.headers as Record<string, unknown>,
      }));
  }
}
