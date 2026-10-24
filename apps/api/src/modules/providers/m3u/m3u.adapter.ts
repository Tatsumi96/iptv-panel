import { Injectable, Logger } from '@nestjs/common';
import { CategoryKind, ProviderKind } from '@prisma/client';
import { AxiosInstance } from 'axios';
import { HttpClientFactory } from '../http-client.factory';
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
import { buildGroupsFromEntries, M3uEntry, parseM3U } from './m3u.parser';
import { parseXmltv } from '../xmltv.parser';

export interface M3uProviderOptions {
  providerId: string;
  playlistUrl: string;
  /** Optional XMLTV feed used to build the EPG for M3U sources. */
  epgUrl?: string;
  /** Base URL used to resolve relative media URLs found in the playlist. */
  baseUrl?: string;
  /** Cache lifetime of the parsed playlist (seconds). */
  cacheTtlSec?: number;
}

/**
 * Adapter that turns a plain M3U/M3U8 playlist into a full-blown provider.
 *
 * This is what makes "M3U as a provider" possible: the gateway exposes the
 * very same Xtream-compatible API (`player_api.php`, `get.php`, ...) on top
 * of a playlist that only contained raw URLs.
 */
@Injectable()
export class M3uAdapter implements IProviderAdapter {
  readonly kind: ProviderKind = ProviderKind.M3U;
  private readonly logger = new Logger(M3uAdapter.name);
  private readonly http: AxiosInstance;

  private cached: { entries: M3uEntry[]; fetchedAt: number } | null = null;
  private inflight: Promise<M3uEntry[]> | null = null;

  constructor(
    private readonly options: M3uProviderOptions,
    private readonly httpFactory: HttpClientFactory,
  ) {
    this.http = this.httpFactory.create({
      timeoutMs: 30_000,
      maxContentLength: 256 * 1024 * 1024,
    });
  }

  get providerId(): string {
    return this.options.providerId;
  }

  get baseUrl(): string {
    return this.options.baseUrl ?? this.options.playlistUrl;
  }

  /** Fetches and parses the playlist with a short TTL cache + request coalescing. */
  async entries(): Promise<M3uEntry[]> {
    const ttlMs = (this.options.cacheTtlSec ?? 300) * 1000;
    if (this.cached && Date.now() - this.cached.fetchedAt < ttlMs) {
      return this.cached.entries;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchEntries()
      .then((entries) => {
        this.cached = { entries, fetchedAt: Date.now() };
        return entries;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  private async fetchEntries(): Promise<M3uEntry[]> {
    const response = await this.http.get<string>(this.options.playlistUrl, {
      responseType: 'text',
      transformResponse: [(data: unknown) => data],
      timeout: 60_000,
    });

    if (response.status >= 400) {
      throw new Error(`Playlist M3U indisponible (HTTP ${response.status})`);
    }

    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    const entries = parseM3U(body);
    this.logger.log(`Playlist M3U chargee: ${entries.length} entrees`);
    return entries;
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const entries = await this.entries();
      const latencyMs = Date.now() - started;
      return {
        ok: entries.length > 0,
        latencyMs,
        maxConnections: undefined,
        message: `Playlist accessible (${entries.length} entrees)`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Echec de lecture de la playlist: ${(error as Error).message}`,
      };
    }
  }

  async userInfo(): Promise<UpstreamUserInfo> {
    const entries = await this.entries();
    return {
      username: 'm3u',
      password: '',
      expDate: 0,
      maxConnections: 1,
      activeConnections: 0,
      status: 'active',
      message: `Source M3U (${entries.length} entrees)`,
      auth: 1,
    };
  }

  async categories(kind: CategoryKind): Promise<UpstreamCategory[]> {
    const entries = await this.entries();
    if (kind !== CategoryKind.LIVE) return [];

    const groups = buildGroupsFromEntries(entries);
    const categories: UpstreamCategory[] = [];
    let index = 1;

    for (const [name, parents] of groups) {
      categories.push({
        categoryId: String(index++),
        categoryName: name,
        sortOrder: index,
      });
      for (const parent of parents) {
        categories.push({
          categoryId: String(index++),
          categoryName: parent,
          sortOrder: index,
        });
      }
    }
    return categories;
  }

  async liveStreams(categoryId?: string): Promise<UpstreamChannel[]> {
    const entries = await this.entries();
    const live = entries.filter((entry) => !entry.isVod);
    const groups = buildGroupsFromEntries(entries);

    const categoryIndex = new Map<string, string>();
    let index = 1;
    for (const [name] of groups) {
      categoryIndex.set(name.toLowerCase(), String(index++));
      for (const _parent of groups.get(name) ?? []) {
        index++;
      }
    }

    const result: UpstreamChannel[] = [];
    live.forEach((entry, position) => {
      const group = (entry.groupTitle ?? '').trim();
      const leaf = group.split('|').map((p) => p.trim()).filter(Boolean).pop() ?? '';
      result.push({
        num: position + 1,
        name: entry.name,
        streamType: 'live',
        streamId: this.streamIdFor(entry, position),
        streamIcon: entry.tvgLogo,
        epgChannelId: entry.tvgId,
        added: String(Math.floor(Date.now() / 1000)),
        categoryId: categoryIndex.get(leaf.toLowerCase()) ?? '1',
        directSource: entry.url,
      });
    });

    if (categoryId) {
      const filtered = result.filter((item) => item.categoryId === categoryId);
      return filtered;
    }
    return result;
  }

  async vodStreams(categoryId?: string): Promise<UpstreamMovie[]> {
    const entries = await this.entries();
    const vod = entries.filter((entry) => entry.isVod);
    const result: UpstreamMovie[] = [];
    vod.forEach((entry, position) => {
      result.push({
        num: position + 1,
        name: entry.name,
        streamType: 'movie',
        streamId: this.streamIdFor(entry, position),
        streamIcon: entry.tvgLogo,
        duration: entry.durationSec,
        categoryId: categoryId ?? '1',
        added: String(Math.floor(Date.now() / 1000)),
      });
    });
    return result;
  }

  async series(): Promise<UpstreamSeries[]> {
    // A plain playlist carries no series metadata.
    return [];
  }

  async seriesInfo(): Promise<UpstreamSeriesInfo> {
    return { seasons: [], episodes: [], info: {} };
  }

  async vodInfo(vodId: string): Promise<UpstreamMovie> {
    const entries = await this.entries();
    const vod = entries.filter((entry) => entry.isVod);
    const position = Number(vodId);
    const entry = vod[position];
    if (!entry) {
      return {
        num: 0,
        name: 'Indisponible',
        streamType: 'movie',
        streamId: vodId,
        categoryId: '1',
      };
    }
    return {
      num: position + 1,
      name: entry.name,
      streamType: 'movie',
      streamId: vodId,
      streamIcon: entry.tvgLogo,
      duration: entry.durationSec,
      categoryId: '1',
    };
  }

  async resolveStreamUrl(
    kind: StreamKind,
    externalId: string,
  ): Promise<string> {
    const entries = await this.entries();
    const index = Number(externalId);
    const pool = kind === StreamKind.VOD ? entries.filter((e) => e.isVod) : entries.filter((e) => !e.isVod);
    const entry = pool[index];
    if (!entry) throw new Error(`Flux introuvable dans la playlist M3U: ${externalId}`);

    if (/^https?:\/\//i.test(entry.url)) return entry.url;
    const base = this.baseUrl.replace(/\/+$/, '');
    return `${base}/${entry.url.replace(/^\/+/, '')}`;
  }

  async epg(): Promise<UpstreamEpg[]> {
    if (!this.options.epgUrl) return [];
    try {
      const response = await this.http.get<string>(this.options.epgUrl, {
        responseType: 'text',
        transformResponse: [(data: unknown) => data],
        timeout: 60_000,
      });
      if (response.status >= 400 || typeof response.data !== 'string') return [];
      return parseXmltv(response.data);
    } catch (error) {
      this.logger.warn(`EPG M3U indisponible: ${(error as Error).message}`);
      return [];
    }
  }

  /** Stable, URL-derived stream id so the identifier survives playlist refreshes. */
  private streamIdFor(entry: M3uEntry, position: number): string {
    let hash = 5381;
    const source = entry.url || entry.name;
    for (let i = 0; i < source.length; i += 1) {
      hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    const positive = Math.abs(hash).toString(36);
    return `${positive}${position.toString(36)}`;
  }
}
