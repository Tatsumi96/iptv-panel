import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { environmentValidator } from './env.validation';
import { AppConfigService } from './app-config.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: environmentValidator,
    }),
  ],
  providers: [
    AppConfigService,
    {
      provide: 'APP_CONFIG_SANITY',
      useFactory: (config: ConfigService) => {
        // Fail fast if a mandatory secret is missing.
        const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
        const missing = required.filter((key) => !config.get(key));
        if (missing.length) {
          throw new Error(
            `Variables d'environnement manquantes: ${missing.join(', ')} — copiez .env.example vers .env`,
          );
        }
        return true;
      },
      inject: [ConfigService],
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
