import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

/**
 * Redis access point.
 *
 * A single command connection plus a dedicated subscriber connection
 * (Redis forbids subscribing on a connection used for normal commands).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private subscriber!: Redis;
  private ready = false;

  constructor(private readonly appConfig: AppConfigService) {}

  onModuleInit(): void {
    const { url, password, db } = this.appConfig.redis;

    const options: RedisOptions = {
      password: password || undefined,
      db,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      keepAlive: 10_000,
      connectionName: 'iptv-gateway',
      retryStrategy: (times) => {
        if (times > 10) {
          this.logger.error('Redis injoignable, abandon des tentatives de reconnexion');
          return null;
        }
        const delay = Math.min(times * 200, 5_000);
        this.logger.warn(`Reconnexion Redis dans ${delay}ms (tentative ${times})`);
        return delay;
      },
    };

    this.client = new Redis(url, options);
    this.subscriber = new Redis(url, { ...options, connectionName: 'iptv-gateway-sub' });

    this.client.on('ready', () => {
      this.ready = true;
      this.logger.log('Redis pret');
    });
    this.client.on('error', (err) => this.logger.error(`Redis: ${err.message}`));
    this.client.on('end', () => {
      this.ready = false;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client?.quit(), this.subscriber?.quit()]);
  }

  get isReady(): boolean {
    return this.ready && this.client?.status === 'ready';
  }

  get commands(): Redis {
    return this.client;
  }

  get pubsub(): Redis {
    return this.subscriber;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
