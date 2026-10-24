import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminRole, AdminUser, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../common/config/app-config.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/ratelimit/rate-limit.service';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  displayName: string | null;
  role: AdminRole;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  /**
   * Hash of a throwaway password. Verifying against it when the account
   * does not exist keeps the response time constant and prevents user
   * enumeration through timing.
   */
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly appConfig: AppConfigService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Creates the first administrator if the table is empty. */
  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);

    const count = await this.prisma.adminUser.count();
    if (count > 0) return;

    const bootstrap = this.appConfig.bootstrapAdmin;
    if (!bootstrap.password) {
      this.logger.warn(
        "Aucun administrateur n'existe et ADMIN_PASSWORD n'est pas defini: le panel est inaccessible.",
      );
      return;
    }

    await this.prisma.adminUser.create({
      data: {
        email: bootstrap.email,
        passwordHash: await argon2.hash(bootstrap.password, ARGON2_OPTIONS),
        displayName: bootstrap.displayName,
        role: AdminRole.OWNER,
      },
    });

    this.logger.log(`Administrateur initial cree: ${bootstrap.email}`);
  }

  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<{ admin: AuthenticatedAdmin; tokens: TokenPair }> {
    const { loginWindowSec, loginMaxAttempts, loginBlockSec, adminMaxFailedLogins, adminLockMinutes } =
      this.appConfig.rateLimit;

    const ip = meta.ip ?? 'unknown';
    const normalizedEmail = email.trim().toLowerCase();

    if (await this.rateLimit.isBlocked('admin-ip', ip)) {
      throw new UnauthorizedException('Trop de tentatives. Reessayez plus tard.');
    }
    if (await this.rateLimit.isBlocked('admin-email', normalizedEmail)) {
      throw new UnauthorizedException('Trop de tentatives. Reessayez plus tard.');
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });

    // Constant-ish time: always run the argon2 verification, even for
    // unknown accounts, to avoid user enumeration through timing.
    const hash = admin?.passwordHash ?? this.dummyHash;
    const valid = await argon2.verify(hash, password).catch(() => false);

    if (!admin || !valid || !admin.isActive) {
      await this.registerFailure(ip, normalizedEmail, loginWindowSec, loginMaxAttempts, loginBlockSec);

      if (admin) {
        const failed = admin.failedLogins + 1;
        const lockedUntil =
          failed >= adminMaxFailedLogins
            ? new Date(Date.now() + adminLockMinutes * 60_000)
            : admin.lockedUntil;

        await this.prisma.adminUser.update({
          where: { id: admin.id },
          data: { failedLogins: failed, lockedUntil },
        });
      }

      throw new UnauthorizedException('Identifiants invalides');
    }

    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Compte temporairement verrouille');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      },
    });

    await this.rateLimit.clearFailures('admin-ip', ip);
    await this.rateLimit.clearFailures('admin-email', normalizedEmail);

    const tokens = await this.issueTokens(admin, meta);
    return { admin: this.toPrincipal(admin), tokens };
  }

  async refresh(refreshToken: string, meta: { ip?: string; userAgent?: string } = {}): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Jeton de rafraichissement invalide');
    }
    if (!stored.user.isActive) {
      throw new UnauthorizedException('Compte desactive');
    }

    // Rotation: the old token is revoked as soon as a new one is issued.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user, meta);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async validateAccessToken(token: string): Promise<AuthenticatedAdmin> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        email: string;
        role: AdminRole;
        type: string;
      }>(token, { secret: this.appConfig.jwt.accessSecret });

      if (payload.type !== 'access') throw new Error('wrong token type');

      const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
      if (!admin || !admin.isActive) throw new Error('inactive account');

      return this.toPrincipal(admin);
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expire');
    }
  }

  private async issueTokens(
    admin: AdminUser,
    meta: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const { accessSecret, accessTtl, refreshTtl } = this.appConfig.jwt;

    const accessToken = await this.jwt.signAsync(
      {
        sub: admin.id,
        email: admin.email,
        role: admin.role,
        type: 'access',
      },
      { secret: accessSecret, expiresIn: accessTtl as never },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.parseDuration(refreshTtl));

    await this.prisma.refreshToken.create({
      data: {
        userId: admin.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ip: meta.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseDuration(accessTtl),
    };
  }

  private async registerFailure(
    ip: string,
    email: string,
    windowSec: number,
    maxAttempts: number,
    blockSec: number,
  ): Promise<void> {
    const ipAttempts = await this.rateLimit.registerFailure('admin-ip', ip, windowSec);
    const emailAttempts = await this.rateLimit.registerFailure('admin-email', email, windowSec);

    if (ipAttempts >= maxAttempts) await this.rateLimit.block('admin-ip', ip, blockSec);
    if (emailAttempts >= maxAttempts) await this.rateLimit.block('admin-email', email, blockSec);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDuration(value: string): number {
    const match = value.match(/^(\d+)([smhd])?$/);
    if (!match) return 900_000;
    const amount = Number(match[1]);
    switch (match[2]) {
      case 's':
        return amount * 1000;
      case 'm':
        return amount * 60_000;
      case 'h':
        return amount * 3_600_000;
      case 'd':
        return amount * 86_400_000;
      default:
        return amount;
    }
  }

  private toPrincipal(admin: AdminUser): AuthenticatedAdmin {
    return {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
    };
  }
}
