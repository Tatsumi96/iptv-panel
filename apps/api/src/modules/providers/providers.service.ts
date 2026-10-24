import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OverflowPolicy,
  Prisma,
  ProviderKind,
  ProviderStatus,
  UpstreamProvider,
} from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProviderAdapterFactory } from './provider-adapter.factory';
import { IProviderAdapter, ProviderHealth } from './provider-adapter.port';

export interface UpsertProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  playlistUrl?: string;
  username?: string;
  password?: string;
  maxConnections?: number;
  overflowPolicy?: OverflowPolicy;
  refreshIntervalSec?: number;
  epgUrl?: string;
  extraHeaders?: Record<string, string>;
  isEnabled?: boolean;
}

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  playlistUrl: string | null;
  hasCredentials: boolean;
  usernameHint: string | null;
  maxConnections: number;
  activeConnections: number;
  overflowPolicy: OverflowPolicy;
  status: ProviderStatus;
  isEnabled: boolean;
  lastTestedAt: Date | null;
  lastError: string | null;
  lastSyncedAt: Date | null;
  refreshIntervalSec: number;
  epgUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly factory: ProviderAdapterFactory,
  ) {}

  async list(): Promise<ProviderView[]> {
    const providers = await this.prisma.upstreamProvider.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return providers.map((provider) => this.toView(provider));
  }

  async getRaw(providerId: string): Promise<UpstreamProvider> {
    const provider = await this.prisma.upstreamProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider) throw new NotFoundException(`Provider ${providerId} introuvable`);
    return provider;
  }

  async get(providerId: string): Promise<ProviderView> {
    return this.toView(await this.getRaw(providerId));
  }

  async adapter(providerId: string): Promise<IProviderAdapter> {
    return this.factory.create(await this.getRaw(providerId));
  }

  async create(input: UpsertProviderInput): Promise<ProviderView> {
    this.assertKind(input);

    const provider = await this.prisma.upstreamProvider.create({
      data: {
        name: input.name,
        kind: input.kind,
        baseUrl: this.normalizeUrl(input.baseUrl),
        playlistUrl: input.playlistUrl ? this.normalizeUrl(input.playlistUrl) : null,
        secretsEnc: this.sealCredentials(input),
        maxConnections: input.maxConnections ?? 1,
        overflowPolicy: input.overflowPolicy ?? OverflowPolicy.REJECT,
        refreshIntervalSec: input.refreshIntervalSec ?? 3600,
        isEnabled: input.isEnabled ?? true,
        extraHeaders: (input.extraHeaders ?? null) as Prisma.InputJsonValue,
        settings: {
          ...(input.epgUrl ? { epgUrl: input.epgUrl } : {}),
        } as Prisma.InputJsonValue,
      },
    });

    this.factory.invalidate(provider.id);
    return this.toView(provider);
  }

  async update(providerId: string, input: Partial<UpsertProviderInput>): Promise<ProviderView> {
    const current = await this.getRaw(providerId);

    const data: Prisma.UpstreamProviderUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.baseUrl !== undefined) data.baseUrl = this.normalizeUrl(input.baseUrl);
    if (input.playlistUrl !== undefined) {
      data.playlistUrl = input.playlistUrl ? this.normalizeUrl(input.playlistUrl) : null;
    }
    if (input.maxConnections !== undefined) data.maxConnections = Math.max(1, input.maxConnections);
    if (input.overflowPolicy !== undefined) data.overflowPolicy = input.overflowPolicy;
    if (input.refreshIntervalSec !== undefined) {
      data.refreshIntervalSec = Math.max(60, input.refreshIntervalSec);
    }
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
    if (input.extraHeaders !== undefined) {
      data.extraHeaders = input.extraHeaders as Prisma.InputJsonValue;
    }
    if (input.epgUrl !== undefined) {
      const settings = (current.settings ?? {}) as Record<string, unknown>;
      data.settings = {
        ...settings,
        ...(input.epgUrl ? { epgUrl: input.epgUrl } : { epgUrl: undefined }),
      } as Prisma.InputJsonValue;
    }
    if (input.username !== undefined || input.password !== undefined) {
      data.secretsEnc = this.sealCredentials({
        kind: current.kind,
        username: input.username ?? this.currentUsername(current),
        password: input.password ?? this.currentPassword(current),
      });
    }
    if (input.kind !== undefined && input.kind !== current.kind) {
      throw new BadRequestException(
        "Le type de provider ne peut pas etre change apres creation (creez-en un nouveau)",
      );
    }

    const updated = await this.prisma.upstreamProvider.update({
      where: { id: providerId },
      data,
    });

    this.factory.invalidate(providerId);
    return this.toView(updated);
  }

  async remove(providerId: string): Promise<void> {
    const used = await this.prisma.ticket.count({ where: { providerId } });
    if (used > 0) {
      throw new BadRequestException(
        `Impossible de supprimer: ${used} ticket(s) utilisent encore ce provider`,
      );
    }
    await this.prisma.upstreamProvider.delete({ where: { id: providerId } });
    this.factory.invalidate(providerId);
  }

  /**
   * Tests the upstream connection and, for Xtream providers, refreshes the
   * `max_connections` value read from `player_api.php`.
   */
  async testConnection(providerId: string): Promise<ProviderHealth> {
    const provider = await this.getRaw(providerId);

    try {
      const adapter = await this.adapter(providerId);
      const health = await adapter.health();

      await this.prisma.upstreamProvider.update({
        where: { id: providerId },
        data: {
          status: health.ok ? ProviderStatus.ONLINE : ProviderStatus.OFFLINE,
          lastTestedAt: new Date(),
          lastError: health.ok ? null : health.message,
          ...(health.maxConnections && health.maxConnections > 0
            ? { maxConnections: health.maxConnections }
            : {}),
        },
      });

      if (health.ok) {
        this.logger.log(
          `Provider ${provider.name} OK (max=${health.maxConnections ?? '?'}, ${health.latencyMs}ms)`,
        );
      }
      return health;
    } catch (error) {
      const message = (error as Error).message;
      await this.prisma.upstreamProvider.update({
        where: { id: providerId },
        data: {
          status: ProviderStatus.OFFLINE,
          lastTestedAt: new Date(),
          lastError: message,
        },
      });
      return { ok: false, latencyMs: 0, message };
    }
  }

  /** Refreshes only the upstream connection limit (called by the scheduler). */
  async refreshMaxConnections(providerId: string): Promise<number | null> {
    try {
      const adapter = await this.adapter(providerId);
      const info = await adapter.userInfo();
      if (!info.maxConnections) return null;

      await this.prisma.upstreamProvider.update({
        where: { id: providerId },
        data: { maxConnections: info.maxConnections, status: ProviderStatus.ONLINE },
      });
      return info.maxConnections;
    } catch (error) {
      this.logger.warn(
        `Impossible de lire max_connections du provider ${providerId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private assertKind(input: UpsertProviderInput): void {
    if (input.kind === ProviderKind.XTREAM && !input.username) {
      throw new BadRequestException("Un identifiant utilisateur est requis pour un provider XTREAM");
    }
    if (input.kind === ProviderKind.M3U && !input.playlistUrl && !input.baseUrl) {
      throw new BadRequestException("Une URL de playlist M3U est requise pour un provider M3U");
    }
  }

  private sealCredentials(input: {
    kind?: ProviderKind;
    username?: string;
    password?: string;
  }): string | null {
    const payload: Record<string, string> = {};
    if (input.username !== undefined) payload.username = input.username;
    if (input.password !== undefined) payload.password = input.password;
    if (!Object.keys(payload).length) return null;
    return this.crypto.sealJson(payload);
  }

  private currentUsername(provider: UpstreamProvider): string | undefined {
    if (!provider.secretsEnc) return undefined;
    try {
      const payload = this.crypto.openJson<Record<string, unknown>>(provider.secretsEnc);
      return payload.username ? String(payload.username) : undefined;
    } catch {
      return undefined;
    }
  }

  private currentPassword(provider: UpstreamProvider): string | undefined {
    if (!provider.secretsEnc) return undefined;
    try {
      const payload = this.crypto.openJson<Record<string, unknown>>(provider.secretsEnc);
      return payload.password ? String(payload.password) : undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  /** Never exposes the raw secrets — only a masked hint. */
  private toView(provider: UpstreamProvider): ProviderView {
    const settings = (provider.settings ?? {}) as Record<string, unknown>;
    const username = this.currentUsername(provider);

    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      playlistUrl: provider.playlistUrl,
      hasCredentials: Boolean(provider.secretsEnc),
      usernameHint: username ? this.mask(username) : null,
      maxConnections: provider.maxConnections,
      activeConnections: provider.activeConnections,
      overflowPolicy: provider.overflowPolicy,
      status: provider.status,
      isEnabled: provider.isEnabled,
      lastTestedAt: provider.lastTestedAt,
      lastError: provider.lastError,
      lastSyncedAt: provider.lastSyncedAt,
      refreshIntervalSec: provider.refreshIntervalSec,
      epgUrl: settings.epgUrl ? String(settings.epgUrl) : null,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    };
  }

  private mask(value: string): string {
    if (value.length <= 2) return '**';
    return `${value.slice(0, 2)}${'*'.repeat(Math.min(6, value.length - 2))}`;
  }
}
