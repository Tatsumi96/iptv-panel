import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Ticket } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { TicketsService } from '../../modules/tickets/tickets.service';
import { IpBlockService } from '../../modules/security/ip-block.service';

export interface TicketCredentials {
  username: string;
  password: string;
}

/**
 * Authenticates an IPTV client (IPTV Smarters, TiviMate, Xtream apps).
 *
 * Protections:
 *  - sliding-window brute-force detection per IP and per username,
 *  - immediate rejection when the source is blocked,
 *  - constant-time password comparison,
 *  - ticket status/expiry checked on *every* request (not only by the cron).
 */
@Injectable()
export class TicketAuthGuard implements CanActivate {
  private readonly logger = new Logger(TicketAuthGuard.name);

  constructor(
    private readonly tickets: TicketsService,
    private readonly crypto: CryptoService,
    private readonly rateLimit: RateLimitService,
    private readonly ipBlocks: IpBlockService,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const credentials = this.extractCredentials(request);
    const ip = this.clientIp(request);

    if (!credentials.username || !credentials.password) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Identifiants manquants.',
        user_info: { auth: 0, status: 'disabled', message: 'Identifiants manquants' },
      });
    }

    const { loginWindowSec, loginMaxAttempts, loginBlockSec } = this.appConfig.rateLimit;

    if (await this.rateLimit.isBlocked('ticket-ip', ip)) {
      throw new TooManyAttemptsException(
        'Trop de tentatives depuis cette adresse. Reessayez plus tard.',
      );
    }
    if (await this.rateLimit.isBlocked('ticket-user', credentials.username)) {
      throw new TooManyAttemptsException(
        'Trop de tentatives pour cet identifiant. Reessayez plus tard.',
      );
    }

    const ticket = await this.tickets.findByUsername(credentials.username);

    if (!ticket || !this.crypto.safeEquals(ticket.password, credentials.password)) {
      await this.registerFailure(ip, credentials.username, loginWindowSec, loginMaxAttempts, loginBlockSec);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Identifiants invalides.',
        user_info: { auth: 0, status: 'disabled', message: 'Identifiants invalides' },
      });
    }

    // Valid credentials: clear the failure counters.
    await this.rateLimit.clearFailures('ticket-ip', ip);
    await this.rateLimit.clearFailures('ticket-user', credentials.username);

    const blockingRule = await this.ipBlocks.findBlockingRule(ip, ticket.id);
    if (blockingRule) {
      this.logger.warn(`Acces refuse pour ${ip} (regle ${blockingRule.cidr})`);
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Cette adresse est bloquee.',
        user_info: { auth: 0, status: 'disabled', message: 'Adresse IP bloquee' },
      });
    }

    // Expiry / suspension is re-evaluated on every single request.
    await this.tickets.assertUsable(ticket);

    request.ticket = ticket;
    request.clientIp = ip;

    return true;
  }

  private async registerFailure(
    ip: string,
    username: string,
    windowSec: number,
    maxAttempts: number,
    blockSec: number,
  ): Promise<void> {
    const ipAttempts = await this.rateLimit.registerFailure('ticket-ip', ip, windowSec);
    const userAttempts = await this.rateLimit.registerFailure('ticket-user', username, windowSec);

    if (ipAttempts >= maxAttempts) {
      await this.rateLimit.block('ticket-ip', ip, blockSec);
      this.logger.warn(`IP ${ip} bloquee (${ipAttempts} tentatives)`);
    }
    if (userAttempts >= maxAttempts) {
      await this.rateLimit.block('ticket-user', username, blockSec);
      this.logger.warn(`Identifiant ${username} bloque (${userAttempts} tentatives)`);
    }
  }

  private extractCredentials(request: Request): TicketCredentials {
    const query = request.query as Record<string, string | undefined>;
    const params = request.params as Record<string, string | undefined>;

    return {
      username: (query.username ?? params.username ?? '').trim(),
      password: (query.password ?? params.password ?? '').trim(),
    };
  }

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

export class TooManyAttemptsException extends ForbiddenException {
  constructor(message: string) {
    super({
      statusCode: 429,
      error: 'Too Many Requests',
      message,
      user_info: { auth: 0, status: 'disabled', message },
    });
  }
}
