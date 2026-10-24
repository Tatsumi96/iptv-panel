import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateIf,
  IsBase64,
} from 'class-validator';

/**
 * Environment contract of the gateway.
 * Validation happens at boot: a misconfigured instance refuses to start
 * instead of failing later in production.
 */
export class EnvironmentVariables {
  @IsEnum(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'production';

  @IsInt()
  @Min(1)
  @IsOptional()
  API_PORT?: number;

  @IsString()
  @IsOptional()
  API_GLOBAL_PREFIX?: string;

  @IsString()
  @IsOptional()
  PUBLIC_BASE_URL?: string;

  @IsString()
  @IsOptional()
  CORS_ORIGINS?: string;

  // --- Database ---------------------------------------------------------
  @IsString()
  DATABASE_URL!: string;

  // --- Redis ------------------------------------------------------------
  @IsString()
  REDIS_URL!: string;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @IsInt()
  @IsOptional()
  REDIS_DB?: number;

  // --- Crypto -----------------------------------------------------------
  /** base64 of 32 raw bytes */
  @IsString()
  @ValidateIf((o) => o.ENCRYPTION_KEY !== '')
  @IsBase64()
  ENCRYPTION_KEY!: string;

  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_TTL?: string;

  @IsString()
  @IsOptional()
  JWT_REFRESH_TTL?: string;

  // --- Bootstrap admin --------------------------------------------------
  @IsString()
  @IsOptional()
  ADMIN_EMAIL?: string;

  @IsString()
  @IsOptional()
  ADMIN_PASSWORD?: string;

  @IsString()
  @IsOptional()
  ADMIN_DISPLAY_NAME?: string;

  // --- Policies ---------------------------------------------------------
  @IsEnum(['REJECT', 'EVICT_OLDEST'])
  @IsOptional()
  TICKET_OVERFLOW_POLICY?: 'REJECT' | 'EVICT_OLDEST';

  @IsEnum(['REJECT', 'EVICT_OLDEST'])
  @IsOptional()
  UPSTREAM_OVERFLOW_POLICY?: 'REJECT' | 'EVICT_OLDEST';

  @IsInt()
  @Min(1)
  @IsOptional()
  DEFAULT_TICKET_MAX_CONNECTIONS?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  DEFAULT_MAX_CONNECTIONS?: number;

  // --- Rate limiting ----------------------------------------------------
  @IsInt()
  @Min(1)
  @IsOptional()
  RATE_LIMIT_WINDOW_SEC?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  RATE_LIMIT_MAX_REQUESTS?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  LOGIN_RATE_WINDOW_SEC?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  LOGIN_RATE_MAX_ATTEMPTS?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  LOGIN_RATE_BLOCK_SEC?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  ADMIN_MAX_FAILED_LOGINS?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  ADMIN_LOCK_MINUTES?: number;

  // --- Streaming --------------------------------------------------------
  @IsInt()
  @Min(1)
  @IsOptional()
  STREAM_MAX_CLIENTS_PER_FEED?: number;

  @IsInt()
  @Min(5)
  @IsOptional()
  STREAM_IDLE_TIMEOUT_SEC?: number;

  @IsInt()
  @Min(1024)
  @IsOptional()
  STREAM_RELAY_CHUNK_SIZE?: number;

  @IsString()
  @IsOptional()
  INSTANCE_ID?: string;

  // --- Cron -------------------------------------------------------------
  @IsString()
  @IsOptional()
  CONTENT_SYNC_CRON?: string;

  @IsString()
  @IsOptional()
  EPG_SYNC_CRON?: string;

  @IsString()
  @IsOptional()
  TICKET_EXPIRY_CRON?: string;

  // --- Misc -------------------------------------------------------------
  @IsString()
  @IsOptional()
  LOG_LEVEL?: string;

  @IsBoolean()
  @IsOptional()
  TRUST_PROXY?: boolean;
}

export const environmentValidator = (config: Record<string, unknown>) => {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Configuration environment invalide:\n${details}`);
  }

  // Wrapped under the `env` namespace: ConfigModule merges this object into
  // the config tree, so `config.get('env.X')` and `config.get('env')` both work.
  return { env: validated };
};
