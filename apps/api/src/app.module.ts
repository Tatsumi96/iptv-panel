import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfigModule } from './common/config/app-config.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { RateLimitModule } from './common/ratelimit/rate-limit.module';

import { ProvidersModule } from './modules/providers/providers.module';
import { ContentModule } from './modules/content/content.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { ConnectionsModule } from './modules/connections/connections.module';
import { SecurityModule } from './modules/security/security.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { XtreamModule } from './modules/xtream/xtream.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';

import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    AppConfigModule,
    CryptoModule,
    PrismaModule,
    RedisModule,
    RateLimitModule,

    ProvidersModule,
    ContentModule,
    TicketsModule,
    ConnectionsModule,
    SecurityModule,
    StreamingModule,
    XtreamModule,
    AuthModule,
    AdminModule,
    SchedulerModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      // Global traffic shaper: protects the whole surface, including the
      // Xtream-compatible endpoints.
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
