import { Injectable, Logger } from '@nestjs/common';
import { ProviderKind, UpstreamProvider } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IProviderAdapter, ProviderHealth } from './provider-adapter.port';
import { HttpClientFactory } from './http-client.factory';
import { M3uAdapter } from './m3u/m3u.adapter';
import { XtreamAdapter } from './xtream/xtream.adapter';

export interface ProviderSettings {
  epgUrl?: string;
  playlistCacheTtlSec?: number;
  requestHeaders?: Record<string, string>;
}

export interface ProviderCredentials {
  username?: string;
  password?: string;
}

/**
 * Creates the right adapter for a provider row.
 *
 * Adapters are cached by provider id: building one is cheap but the
 * M3U adapter holds a playlist cache that must survive between requests.
 */
@Injectable()
export class ProviderAdapterFactory {
  private readonly logger = new Logger(ProviderAdapterFactory.name);
  private readonly cache = new Map<string, { adapter: IProviderAdapter; fingerprint: string }>();

  constructor(
    private readonly httpFactory: HttpClientFactory,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  async create(provider: UpstreamProvider): Promise<IProviderAdapter> {
    const fingerprint = this.fingerprint(provider);
    const cached = this.cache.get(provider.id);
    if (cached && cached.fingerprint === fingerprint) return cached.adapter;

    const adapter = this.build(provider);
    this.cache.set(provider.id, { adapter, fingerprint });
    return adapter;
  }

  /** Drop the cached adapter (used after a provider update). */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private fingerprint(provider: UpstreamProvider): string {
    return [
      provider.kind,
      provider.baseUrl,
      provider.playlistUrl ?? '',
      provider.secretsEnc ?? '',
      JSON.stringify(provider.settings ?? {}),
      provider.extraHeaders ?? '',
    ].join('|');
  }

  private build(provider: UpstreamProvider): IProviderAdapter {
    if (provider.kind === ProviderKind.XTREAM) {
      const credentials = this.readCredentials(provider);
      return new XtreamAdapter(
        provider.id,
        provider.baseUrl,
        {
          username: credentials.username ?? '',
          password: credentials.password ?? '',
        },
        this.httpFactory,
      );
    }

    const settings = this.readSettings(provider);
    const playlistUrl = provider.playlistUrl ?? provider.baseUrl;
    return new M3uAdapter(
      {
        providerId: provider.id,
        playlistUrl,
        epgUrl: settings.epgUrl,
        baseUrl: provider.baseUrl,
        cacheTtlSec: settings.playlistCacheTtlSec ?? 300,
      },
      this.httpFactory,
    );
  }

  private readCredentials(provider: UpstreamProvider): ProviderCredentials {
    if (!provider.secretsEnc) return {};
    try {
      const payload = this.crypto.openJson<Record<string, unknown>>(provider.secretsEnc);
      return {
        username: payload.username ? String(payload.username) : undefined,
        password: payload.password ? String(payload.password) : undefined,
      };
    } catch (error) {
      this.logger.error(
        `Impossible de dechiffrer les identifiants du provider ${provider.id}: ${(error as Error).message}`,
      );
      throw new Error('Identifiants upstream illisibles (cle ENCRYPTION_KEY modifie ?)');
    }
  }

  private readSettings(provider: UpstreamProvider): ProviderSettings {
    const settings = (provider.settings ?? {}) as ProviderSettings;
    return {
      epgUrl: settings.epgUrl,
      playlistCacheTtlSec: settings.playlistCacheTtlSec,
      requestHeaders: settings.requestHeaders,
    };
  }
}
