import { Injectable, Logger } from '@nestjs/common';
import { CategoryKind, ProviderKind } from '@prisma/client';
import { AxiosInstance } from 'axios';
import {
  IProviderAdapter,
  ProviderHealth,
  StreamKind,
  UpstreamCategory,
  UpstreamChannel,
  UpstreamEpg,
  UpstreamMovie,
  UpstreamSeries,
  UpstreamSeriesInfo,
  UpstreamUserInfo,
} from '../provider-adapter.port';
import { HttpClientFactory } from '../http-client.factory';
import { parseXmltv } from '../xmltv.parser';

export interface XtreamCredentials {
  username: string;
  password: string;
}

/**
 * Adapter for a genuine Xtream Codes / Xtream-style panel.
 *
 * Speaks the `player_api.php` and `xmltv.php` dialect.
 */
@Injectable()
export class XtreamAdapter implements IProviderAdapter {
  readonly kind: ProviderKind = ProviderKind.XTREAM;
  private readonly logger = new Logger(XtreamAdapter.name);
  private readonly http: AxiosInstance;

  constructor(
    readonly providerId: string,
    readonly baseUrl: string,
    private readonly credentials: XtreamCredentials,
    private readonly httpFactory: HttpClientFactory,
  ) {
    this.http = this.httpFactory.create({
      timeoutMs: 20_000,
      maxContentLength: 128 * 1024 * 1024,
    });
  }

  private playerApiUrl(action?: string, extra?: Record<string, string>): string {
    return this.httpFactory.buildUrl(
      this.baseUrl,
      '/player_api.php',
      {
        username: this.credentials.username,
        password: this.credentials.password,
        ...(action ? { action } : {}),
        ...extra,
      },
    );
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const info = await this.userInfo();
      const latencyMs = Date.now() - started;
      const ok = info.status === 'active' || info.auth === 1;
      return {
        ok,
        latencyMs,
        maxConnections: info.maxConnections,
        activeConnections: info.activeConnections,
        expDate: info.expDate,
        message: ok
          ? `Connecte (max ${info.maxConnections} connexions)`
          : `Compte upstream indisponible: ${info.message ?? info.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Echec de la connexion: ${(error as Error).message}`,
      };
    }
  }

  async userInfo(): Promise<UpstreamUserInfo> {
    const response = await this.http.get<unknown>(this.playerApiUrl());
    const payload = this.asRecord(response.data);

    if (!response.status || response.status >= 400) {
      throw new Error(`player_api.php a repondu ${response.status}`);
    }

    const userInfo = this.asRecord(payload.user_info);
    const serverInfo = this.asRecord(payload.server_info);

    const auth = Number(userInfo.auth ?? 0);
    const status = Number(userInfo.status ?? 0);
    const expDate = Number(userInfo.exp_date ?? 0);
    const maxConnections = Number(userInfo.max_connections ?? 1);

    return {
      username: String(userInfo.username ?? this.credentials.username),
      password: String(userInfo.password ?? ''),
      expDate,
      maxConnections: maxConnections > 0 ? maxConnections : 1,
      activeConnections: Number(userInfo.active_connections ?? 0),
      status: status === 1 ? 'active' : status === 2 ? 'disabled' : 'unknown',
      message: userInfo.message ? String(userInfo.message) : undefined,
      auth,
      serverInfo,
    };
  }

  async categories(kind: CategoryKind): Promise<UpstreamCategory[]> {
    const action =
      kind === CategoryKind.LIVE
        ? 'get_live_categories'
        : kind === CategoryKind.VOD
          ? 'get_vod_categories'
          : 'get_series_categories';

    const response = await this.http.get<unknown>(this.playerApiUrl(action));
    if (!Array.isArray(response.data)) return [];
    return response.data.map((item, index) => {
      const record = this.asRecord(item);
      return {
        categoryId: String(record.category_id ?? index + 1),
        categoryName: String(record.category_name ?? 'Sans nom'),
        parentId:
          record.parent_id !== undefined && record.parent_id !== null
            ? String(record.parent_id)
            : undefined,
        sortOrder: Number(record.sort_order ?? index),
      };
    });
  }

  async liveStreams(categoryId?: string): Promise<UpstreamChannel[]> {
    const response = await this.http.get<unknown>(
      this.playerApiUrl('get_live_streams', categoryId ? { category_id: categoryId } : undefined),
    );
    if (!Array.isArray(response.data)) return [];
    return response.data.map((item, index) => {
      const record = this.asRecord(item);
      return {
        num: Number(record.num ?? index + 1),
        name: String(record.name ?? 'Sans nom'),
        streamType: String(record.stream_type ?? 'live'),
        streamId: String(record.stream_id ?? ''),
        streamIcon: record.stream_icon ? String(record.stream_icon) : undefined,
        epgChannelId: record.epg_channel_id ? String(record.epg_channel_id) : undefined,
        added: record.added ? String(record.added) : undefined,
        categoryId: String(record.category_id ?? ''),
        custom: record.custom ? String(record.custom) : undefined,
        tvArchive: Number(record.tv_archive ?? 0),
        tvArchiveDuration: Number(record.tv_archive_duration ?? 0),
        directSource: record.direct_source ? String(record.direct_source) : undefined,
      };
    });
  }

  async vodStreams(categoryId?: string): Promise<UpstreamMovie[]> {
    const response = await this.http.get<unknown>(
      this.playerApiUrl('get_vod_streams', categoryId ? { category_id: categoryId } : undefined),
    );
    if (!Array.isArray(response.data)) return [];
    return response.data.map((item, index) => {
      const record = this.asRecord(item);
      return {
        num: Number(record.num ?? index + 1),
        name: String(record.name ?? 'Sans nom'),
        streamType: String(record.stream_type ?? 'movie'),
        streamId: String(record.stream_id ?? ''),
        streamIcon: record.stream_icon ? String(record.stream_icon) : undefined,
        rating: record.rating ? String(record.rating) : undefined,
        releaseYear: record.release_year ? String(record.release_year) : undefined,
        plot: record.plot ? String(record.plot) : undefined,
        cast: record.cast ? String(record.cast) : undefined,
        genre: record.genre ? String(record.genre) : undefined,
        duration: Number(record.duration ?? 0),
        containerExtension: record.container_extension
          ? String(record.container_extension)
          : undefined,
        categoryId: String(record.category_id ?? ''),
        added: record.added ? String(record.added) : undefined,
      };
    });
  }

  async series(categoryId?: string): Promise<UpstreamSeries[]> {
    const response = await this.http.get<unknown>(
      this.playerApiUrl('get_series', categoryId ? { category_id: categoryId } : undefined),
    );
    if (!Array.isArray(response.data)) return [];
    return response.data.map((item, index) => {
      const record = this.asRecord(item);
      return {
        num: Number(record.num ?? index + 1),
        name: String(record.name ?? 'Sans nom'),
        cover: record.cover ? String(record.cover) : undefined,
        plot: record.plot ? String(record.plot) : undefined,
        cast: record.cast ? String(record.cast) : undefined,
        genre: record.genre ? String(record.genre) : undefined,
        releaseDate: record.release_date ? String(record.release_date) : undefined,
        lastModified: record.last_modified ? String(record.last_modified) : undefined,
        rating: record.rating ? String(record.rating) : undefined,
        categoryId: String(record.category_id ?? ''),
      };
    });
  }

  async seriesInfo(seriesId: string): Promise<UpstreamSeriesInfo> {
    const response = await this.http.get<unknown>(
      this.playerApiUrl('get_series_info', { series_id: seriesId }),
    );
    const payload = this.asRecord(response.data);

    const seasons = Array.isArray(payload.seasons)
      ? payload.seasons.map((item) => {
          const record = this.asRecord(item);
          return {
            seasonNumber: Number(record.season_number ?? 0),
            name: record.name ? String(record.name) : undefined,
            episodeCount: Number(record.episode_count ?? 0),
          };
        })
      : [];

    const episodes: UpstreamSeriesInfo['episodes'] = [];
    const episodesMap = this.asRecord(payload.episodes);
    for (const seasonKey of Object.keys(episodesMap)) {
      const list = episodesMap[seasonKey];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const record = this.asRecord(item);
        const info = this.asRecord(record.info);
        episodes.push({
          id: String(record.id ?? ''),
          episodeNum: Number(record.episode_num ?? 0),
          title: String(info.title ?? record.title ?? `Episode ${record.episode_num ?? ''}`),
          season: Number(record.season ?? seasonKey),
          containerExtension: record.container_extension
            ? String(record.container_extension)
            : undefined,
          info,
        });
      }
    }

    return { seasons, episodes, info: this.asRecord(payload.info) };
  }

  async vodInfo(vodId: string): Promise<UpstreamMovie> {
    const response = await this.http.get<unknown>(
      this.playerApiUrl('get_vod_info', { vod_id: vodId }),
    );
    const payload = this.asRecord(response.data);
    const info = this.asRecord(payload.info);
    const record = { ...this.asRecord(payload.movie), ...info };
    return {
      num: Number(record.num ?? 0),
      name: String(record.name ?? 'Sans nom'),
      streamType: String(record.stream_type ?? 'movie'),
      streamId: String(record.stream_id ?? vodId),
      streamIcon: record.stream_icon ? String(record.stream_icon) : undefined,
      rating: record.rating ? String(record.rating) : undefined,
      releaseYear: record.release_year ? String(record.release_year) : undefined,
      plot: record.plot ? String(record.plot) : undefined,
      cast: record.cast ? String(record.cast) : undefined,
      genre: record.genre ? String(record.genre) : undefined,
      duration: Number(record.duration ?? 0),
      containerExtension: record.container_extension
        ? String(record.container_extension)
        : undefined,
      categoryId: String(record.category_id ?? ''),
      added: record.added ? String(record.added) : undefined,
    };
  }

  async resolveStreamUrl(
    kind: StreamKind,
    externalId: string,
    extension?: string,
  ): Promise<string> {
    const { username, password } = this.credentials;
    switch (kind) {
      case StreamKind.LIVE:
        return this.httpFactory.buildUrl(this.baseUrl, `/live/${username}/${password}/${externalId}.ts`);
      case StreamKind.VOD:
        return this.httpFactory.buildUrl(
          this.baseUrl,
          `/movie/${username}/${password}/${externalId}.${extension || 'mp4'}`,
        );
      case StreamKind.EPISODE:
        return this.httpFactory.buildUrl(
          this.baseUrl,
          `/series/${username}/${password}/${externalId}.${extension || 'mp4'}`,
        );
      default:
        throw new Error(`Type de flux non supporte: ${kind}`);
    }
  }

  async epg(): Promise<UpstreamEpg[]> {
    const url = this.httpFactory.buildUrl(this.baseUrl, '/xmltv.php', {
      username: this.credentials.username,
      password: this.credentials.password,
    });

    const response = await this.http.get<string>(url, {
      responseType: 'text',
      transformResponse: [(data) => data],
      timeout: 60_000,
    });

    if (!response.data || typeof response.data !== 'string') return [];
    return parseXmltv(response.data);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
