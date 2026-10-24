import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSec: number;
}

/**
 * Redis-backed rate limiting.
 *
 * Two strategies:
 *  - fixed window (INCR/EXPIRE) for generic traffic shaping;
 *  - sliding window (sorted set) for credential brute-force detection,
 *    which needs an accurate "attempts in the last N seconds" count.
 *
 * Everything is O(log N) and does not touch PostgreSQL, so the limiter
 * stays usable under a flood of requests.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  private prefix(...parts: (string | number)[]): string {
    return `rl:${parts.join(':')}`;
  }

  /** Fixed-window counter. Returns the number of hits inside the window. */
  async increment(
    scope: string,
    identifier: string,
    windowSec: number,
  ): Promise<number> {
    const key = this.prefix(scope, identifier);
    const client = this.redis.commands;
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, windowSec);
    }
    return count;
  }

  /**
   * Consume one token from the generic limiter.
   * Never throws: if Redis is unavailable we fail open (availability first,
   * the upstream account limit remains the real protection).
   */
  async consume(
    scope: string,
    identifier: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    try {
      const count = await this.increment(scope, identifier, windowSec);
      const allowed = count <= limit;
      const ttl = await this.redis.commands.ttl(this.prefix(scope, identifier));
      return {
        allowed,
        remaining: Math.max(0, limit - count),
        limit,
        retryAfterSec: allowed ? 0 : Math.max(1, ttl > 0 ? ttl : windowSec),
      };
    } catch (error) {
      this.logger.warn(`Rate limiter indisponible (fail-open): ${(error as Error).message}`);
      return { allowed: true, remaining: limit, limit, retryAfterSec: 0 };
    }
  }

  /**
   * Sliding-window counter used for brute-force protection.
   * Returns the number of attempts within the window.
   */
  async slidingWindowCount(
    scope: string,
    identifier: string,
    windowSec: number,
  ): Promise<number> {
    const key = this.prefix(scope, identifier);
    const now = Date.now();
    const client = this.redis.commands;
    const pipeline = client.multi();
    pipeline.zremrangebyscore(key, 0, now - windowSec * 1000);
    pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 10)}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowSec * 1000);
    const results = await pipeline.exec();
    const count = results?.[2]?.[1];
    return typeof count === 'number' ? count : 0;
  }

  /** Register a failed credential attempt and report the running total. */
  async registerFailure(
    scope: string,
    identifier: string,
    windowSec: number,
  ): Promise<number> {
    try {
      return await this.slidingWindowCount(scope, identifier, windowSec);
    } catch (error) {
      this.logger.warn(`Sliding window indisponible: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Clear the failure counters after a successful authentication. */
  async clearFailures(scope: string, identifier: string): Promise<void> {
    try {
      await this.redis.commands.del(this.prefix(scope, identifier));
    } catch {
      /* best effort */
    }
  }

  /** Hard block (used to freeze a source for N seconds after abuse). */
  async block(scope: string, identifier: string, blockSec: number): Promise<void> {
    try {
      await this.redis.commands.set(
        this.prefix('block', scope, identifier),
        '1',
        'EX',
        Math.max(1, Math.trunc(blockSec)),
      );
    } catch (error) {
      this.logger.warn(`Impossible de poser le blocage: ${(error as Error).message}`);
    }
  }

  async isBlocked(scope: string, identifier: string): Promise<boolean> {
    try {
      return (await this.redis.commands.exists(this.prefix('block', scope, identifier))) === 1;
    } catch {
      return false;
    }
  }
}
