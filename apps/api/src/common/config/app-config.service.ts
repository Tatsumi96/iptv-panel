import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { OverflowPolicy } from '@prisma/client';

export interface GatewayConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  globalPrefix: string;
  publicBaseUrl: string;
  corsOrigins: string[];
  isProduction: boolean;
}

export interface RedisConfig {
  url: string;
  password?: string;
  db: number;
}

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtl: string;
  refreshTtl: string;
}

export interface PolicyConfig {
  ticketOverflow: OverflowPolicy;
  upstreamOverflow: OverflowPolicy;
  defaultTicketMaxConnections: number;
  defaultMaxConnections: number;
}

export interface RateLimitConfig {
  windowSec: number;
  maxRequests: number;
  loginWindowSec: number;
  loginMaxAttempts: number;
  loginBlockSec: number;
  adminMaxFailedLogins: number;
  adminLockMinutes: number;
}

export interface StreamConfig {
  maxClientsPerFeed: number;
  idleTimeoutSec: number;
  relayChunkSize: number;
  instanceId: string;
}

export interface CronConfig {
  contentSync: string;
  epgSync: string;
  ticketExpiry: string;
}

export interface BootstrapAdminConfig {
  email: string;
  password: string;
  displayName: string;
}

/**
 * Strongly typed facade over `ConfigService`.
 * Single place where environment values are read, coerced and defaulted.
 */
@Injectable()
export class AppConfigService {
  private readonly cfg: Record<string, unknown>;

  constructor(private readonly config: ConfigService) {
    this.cfg = config.get<Record<string, unknown>>('env') ?? {};
  }

  private str(key: string, fallback = ''): string {
    const value = this.cfg[key];
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
  }

  private int(key: string, fallback: number): number {
    const value = Number(this.cfg[key]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  }

  private bool(key: string, fallback = false): boolean {
    const value = this.cfg[key];
    if (value === undefined || value === null) return fallback;
    return value === true || value === 'true' || value === '1';
  }

  get gateway(): GatewayConfig {
    const nodeEnv = this.str('NODE_ENV', 'production') as GatewayConfig['nodeEnv'];
    return {
      nodeEnv,
      port: this.int('API_PORT', 3000),
      globalPrefix: this.str('API_GLOBAL_PREFIX', ''),
      publicBaseUrl: this.str('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
      corsOrigins: this.str('CORS_ORIGINS', 'http://localhost:3001')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      isProduction: nodeEnv === 'production',
    };
  }

  get redis(): RedisConfig {
    return {
      url: this.str('REDIS_URL', 'redis://127.0.0.1:6379'),
      password: this.str('REDIS_PASSWORD') || undefined,
      db: Number(this.cfg['REDIS_DB'] ?? 0) || 0,
    };
  }

  get jwt(): JwtConfig {
    return {
      accessSecret: this.str('JWT_SECRET'),
      refreshSecret: this.str('JWT_REFRESH_SECRET'),
      accessTtl: this.str('JWT_ACCESS_TTL', '15m'),
      refreshTtl: this.str('JWT_REFRESH_TTL', '30d'),
    };
  }

  get encryptionKey(): Buffer {
    const raw = this.str('ENCRYPTION_KEY');
    if (!raw) throw new Error('ENCRYPTION_KEY est requis (base64 de 32 octets)');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY doit faire 32 octets une fois decodee en base64 (recu: ${key.length})`,
      );
    }
    return key;
  }

  get policies(): PolicyConfig {
    return {
      ticketOverflow: this.str('TICKET_OVERFLOW_POLICY', 'REJECT') as OverflowPolicy,
      upstreamOverflow: this.str('UPSTREAM_OVERFLOW_POLICY', 'REJECT') as OverflowPolicy,
      defaultTicketMaxConnections: this.int('DEFAULT_TICKET_MAX_CONNECTIONS', 1),
      defaultMaxConnections: this.int('DEFAULT_MAX_CONNECTIONS', 1),
    };
  }

  get rateLimit(): RateLimitConfig {
    return {
      windowSec: this.int('RATE_LIMIT_WINDOW_SEC', 60),
      maxRequests: this.int('RATE_LIMIT_MAX_REQUESTS', 120),
      loginWindowSec: this.int('LOGIN_RATE_WINDOW_SEC', 300),
      loginMaxAttempts: this.int('LOGIN_RATE_MAX_ATTEMPTS', 10),
      loginBlockSec: this.int('LOGIN_RATE_BLOCK_SEC', 300),
      adminMaxFailedLogins: this.int('ADMIN_MAX_FAILED_LOGINS', 8),
      adminLockMinutes: this.int('ADMIN_LOCK_MINUTES', 15),
    };
  }

  get stream(): StreamConfig {
    return {
      maxClientsPerFeed: this.int('STREAM_MAX_CLIENTS_PER_FEED', 500),
      idleTimeoutSec: this.int('STREAM_IDLE_TIMEOUT_SEC', 90),
      relayChunkSize: this.int('STREAM_RELAY_CHUNK_SIZE', 32768),
      instanceId: this.str('INSTANCE_ID') || randomUUID(),
    };
  }

  get cron(): CronConfig {
    return {
      contentSync: this.str('CONTENT_SYNC_CRON', '*/30 * * * *'),
      epgSync: this.str('EPG_SYNC_CRON', '15 */2 * * *'),
      ticketExpiry: this.str('TICKET_EXPIRY_CRON', '*/5 * * * *'),
    };
  }

  get bootstrapAdmin(): BootstrapAdminConfig {
    return {
      email: this.str('ADMIN_EMAIL', 'admin@iptv.local'),
      password: this.str('ADMIN_PASSWORD'),
      displayName: this.str('ADMIN_DISPLAY_NAME', 'Administrateur'),
    };
  }

  get trustProxy(): boolean {
    return this.bool('TRUST_PROXY', true);
  }
}
