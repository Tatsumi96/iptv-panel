import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config/app-config.service';
import { isOriginAllowed } from './common/config/cors';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaService } from './common/prisma/prisma.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    // The API is served behind nginx; trust the forwarded headers.
    rawBody: false,
  });

  const config = app.get(AppConfigService);
  const prisma = app.get(PrismaService);

  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.enableShutdownHooks();

  // --- CORS (panel admin) ---------------------------------------------------
  const corsOrigins = config.gateway.corsOrigins;
  app.enableCors({
    // A callback is used instead of a plain list so that wildcard patterns
    // (`http://192.168.*.*:8080`) are supported: the panel stays reachable
    // even when the server IP changes.
    origin: (origin, callback) => {
      if (isOriginAllowed(corsOrigins, origin ?? '')) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
    maxAge: 3600,
  });

  // --- Body limits (anti-DDoS) --------------------------------------------
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '256kb' }));

  // --- Validation ----------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
    }),
  );

  // --- Uniform error handling --------------------------------------------
  app.useGlobalFilters(new AllExceptionsFilter(config.gateway.isProduction));

  if (config.gateway.globalPrefix) {
    app.setGlobalPrefix(config.gateway.globalPrefix);
  }

  await app.listen(config.gateway.port, '0.0.0.0');

  logger.log(`IPTV Home Gateway API demarree sur le port ${config.gateway.port}`);
  logger.log(`Base publique: ${config.gateway.publicBaseUrl}`);
  logger.log(`Origine CORS: ${config.gateway.corsOrigins.join(', ') || 'toutes'}`);

  const shutdown = async (signal: string) => {
    logger.log(`Signal ${signal} recu, arret en cours...`);
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Promesse non geree: ${String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Exception non capturee: ${error.message}`, error.stack);
  });
}

void bootstrap();
