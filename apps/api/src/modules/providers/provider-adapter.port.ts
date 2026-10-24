import { CategoryKind, ProviderKind } from '@prisma/client';

export enum StreamKind {
  LIVE = 'live',
  VOD = 'vod',
  EPISODE = 'episode',
}

export interface UpstreamUserInfo {
  username: string;
  password: string;
  /** Unix timestamp (seconds) — 0 or negative means "no expiry". */
  expDate: number;
  maxConnections: number;
  activeConnections: number;
  status: 'active' | 'disabled' | 'unknown';
  message?: string;
  auth: number;
  serverInfo?: Record<string, unknown>;
}

export interface UpstreamCategory {
  categoryId: string;
  categoryName: string;
  parentId?: string;
  sortOrder?: number;
}

export interface UpstreamChannel {
  num: number;
  name: string;
  streamType: string;
  streamId: string;
  streamIcon?: string;
  epgChannelId?: string;
  added?: string;
  categoryId: string;
  custom?: string;
  tvArchive?: number;
  tvArchiveDuration?: number;
  directSource?: string;
}

export interface UpstreamMovie {
  num: number;
  name: string;
  streamType: string;
  streamId: string;
  streamIcon?: string;
  rating?: string;
  releaseYear?: string;
  plot?: string;
  cast?: string;
  genre?: string;
  duration?: number;
  containerExtension?: string;
  categoryId: string;
  added?: string;
}

export interface UpstreamSeries {
  num: number;
  name: string;
  cover?: string;
  plot?: string;
  cast?: string;
  genre?: string;
  releaseDate?: string;
  lastModified?: string;
  rating?: string;
  categoryId: string;
}

export interface UpstreamSeriesInfo {
  seasons: Array<{ seasonNumber: number; name?: string; episodeCount: number }>;
  episodes: Array<{
    id: string;
    episodeNum: number;
    title: string;
    season: number;
    containerExtension?: string;
    info?: Record<string, unknown>;
  }>;
  info: Record<string, unknown>;
}

export interface UpstreamEpg {
  id: string;
  epgId: string;
  title: string;
  lang?: string;
  /** Unix seconds */
  start: number;
  /** Unix seconds */
  stop: number;
  description?: string;
  channelId: string;
  startTimestamp?: number;
  stopTimestamp?: number;
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
  latencyMs: number;
  maxConnections?: number;
  activeConnections?: number;
  expDate?: number;
}

/**
 * Port implemented by every upstream source.
 *
 * The gateway only ever talks to this interface, which is what allows an
 * M3U playlist to be exposed through the exact same Xtream-compatible API
 * as a real Xtream Codes panel.
 */
export interface IProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly baseUrl: string;

  health(): Promise<ProviderHealth>;
  userInfo(): Promise<UpstreamUserInfo>;
  categories(kind: CategoryKind): Promise<UpstreamCategory[]>;
  liveStreams(categoryId?: string): Promise<UpstreamChannel[]>;
  vodStreams(categoryId?: string): Promise<UpstreamMovie[]>;
  series(categoryId?: string): Promise<UpstreamSeries[]>;
  seriesInfo(seriesId: string): Promise<UpstreamSeriesInfo>;
  vodInfo(vodId: string): Promise<UpstreamMovie>;
  /** Absolute, authenticated URL of the media on the upstream server. */
  resolveStreamUrl(kind: StreamKind, externalId: string, extension?: string): Promise<string>;
  epg(): Promise<UpstreamEpg[]>;
}
