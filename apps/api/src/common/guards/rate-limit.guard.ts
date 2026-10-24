import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';

const STREAM_PATHS = /^\/(live|hls|proxy-stream)\//;

/**
 * Global traffic shaper.
 *
 * Every request is accounted against a per-IP budget. Streaming routes get
 * a dedicated, much larger budget because a single viewer produces one
 * long-lived request (not a request per second).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: unknown }>();
    const response = http.getResponse<Response>();
    const path = request.path ?? '';

    if (path === '/health' || path === '/health/live') return true;

    const ip = this.clientIp(request);
    const isStream = STREAM_PATHS.test(path);
    const { maxRequests, windowSec } = this.appConfig.rateLimit;

    const scope = isStream ? 'stream' : 'api';
    const limit = isStream ? maxRequests * 10 : maxRequests;

    const result = await this.rateLimit.consume(scope, ip, limit, windowSec);

    response.setHeader('X-RateLimit-Limit', String(result.limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSec));
      this.logger.warn(`Rate limit atteint pour ${ip} sur ${scope}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Trop de requetes, reessayez plus tard.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Trust proxy headers only when the app runs behind nginx. */
  private clientIp(request: Request): string {
    if (this.appConfig.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const first = raw?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }
}
