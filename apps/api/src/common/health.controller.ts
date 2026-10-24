import { Controller, Get } from '@nestjs/common';
import { RedisService } from './redis/redis.service';
import { PrismaService } from './prisma/prisma.service';

/**
 * Liveness / readiness probe used by Docker and by the dashboard.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  async health() {
    const [database, redis] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      this.redis.ping(),
    ]);

    const healthy = database && redis;
    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSec: Math.round(process.uptime()),
      database,
      redis,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
