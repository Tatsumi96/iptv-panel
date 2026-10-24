import { Category, Channel, EpgEntry, Movie, Series, SeriesEpisode } from '@prisma/client';
import { StreamKindLabel } from '../connections/connection-registry.service';

export interface XtreamServerInfo {
  url: string;
  port: string;
  https_port: string;
  server_protocol: string;
  rtmp_port: string;
  timezone: string;
  timestamp_now: number;
  time_now: string;
}

export interface XtreamUserInfo {
  username: string;
  password: string;
  message: string;
  auth: number;
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
  allowed_output_formats: string[];
}

/**
 * Converts the internal model into the exact JSON shapes expected by
 * IPTV Smarters, TiviMate and the various Xtream applications.
 */
export class XtreamMapper {
  static userInfo(params: {
    username: string;
    password: string;
    status: string;
    expiresAt: Date;
    maxConnections: number;
    activeConnections: number;
    createdAt: Date;
    message?: string;
  }): XtreamUserInfo {
    return {
      username: params.username,
      password: params.password,
      message: params.message ?? '',
      auth: 1,
      status: params.status,
      exp_date: String(Math.floor(params.expiresAt.getTime() / 1000)),
      is_trial: '0',
      active_cons: String(params.activeConnections),
      created_at: String(Math.floor(params.createdAt.getTime() / 1000)),
      max_connections: String(params.maxConnections),
      allowed_output_formats: ['m3u8', 'ts', 'rtmp'],
    };
  }

  static serverInfo(baseUrl: string, timezone = 'Europe/Paris'): XtreamServerInfo {
    const now = new Date();
    let host = baseUrl;
    let port = '80';
    let httpsPort = '443';

    try {
      const parsed = new URL(baseUrl);
      host = parsed.hostname;
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      httpsPort = parsed.protocol === 'https:' ? parsed.port || '443' : '443';
    } catch {
      /* keep defaults */
    }

    return {
      url: host,
      port,
      https_port: httpsPort,
      server_protocol: baseUrl.startsWith('https') ? 'https' : 'http',
      rtmp_port: '1935',
      timezone,
      timestamp_now: Math.floor(now.getTime() / 1000),
      time_now: now.toISOString().slice(0, 19).replace('T', ' '),
    };
  }

  static category(category: Category): Record<string, unknown> {
    return {
      category_id: category.externalId,
      category_name: category.name,
      parent_id: category.parentExternalId ?? 0,
    };
  }

  static channel(
    channel: Channel,
    streamUrl: string,
    categoryId: string,
    channelNumber: number,
  ): Record<string, unknown> {
    return {
      num: channelNumber,
      name: channel.name,
      stream_type: channel.streamType || 'live',
      stream_id: channel.externalId,
      stream_icon: channel.streamIcon ?? '',
      epg_channel_id: channel.epgChannelId ?? channel.tvgId ?? channel.externalId,
      added: String(Math.floor(Date.now() / 1000)),
      category_id: categoryId,
      custom_sid: '',
      tv_archive: channel.timeshift ? 1 : 0,
      direct_source: streamUrl,
      tv_archive_duration: channel.tvArchiveDuration ?? 0,
    };
  }

  static movie(movie: Movie, categoryId: string, streamUrl: string): Record<string, unknown> {
    return {
      num: 0,
      name: movie.name,
      stream_type: 'movie',
      stream_id: movie.externalId,
      stream_icon: movie.streamIcon ?? '',
      rating: movie.rating ?? '',
      release_year: movie.releaseYear ? String(movie.releaseYear) : '',
      plot: movie.plot ?? '',
      cast: '',
      genre: '',
      duration: movie.durationSec ? String(movie.durationSec) : '',
      container_extension: movie.containerExtension ?? 'mp4',
      category_id: categoryId,
      added: movie.addedAt ? String(Math.floor(movie.addedAt.getTime() / 1000)) : '',
      direct_source: streamUrl,
    };
  }

  static movieDetail(movie: Movie, categoryId: string): Record<string, unknown> {
    const info = {
      tmdb_id: '',
      name: movie.name,
      cover_big: movie.streamIcon ?? '',
      movie_image: movie.streamIcon ?? '',
      releasedate: movie.releaseYear ? String(movie.releaseYear) : '',
      plot: movie.plot ?? '',
      duration_secs: movie.durationSec ? String(movie.durationSec) : '',
      duration: movie.durationSec
        ? `${Math.floor(movie.durationSec / 60)} min`
        : '',
      genre: '',
      container_extension: movie.containerExtension ?? 'mp4',
      custom_sid: '',
      rating: movie.rating ?? '',
      stream_id: movie.externalId,
      num: 0,
      stream_type: 'movie',
      category_id: categoryId,
      director: '',
      youtube_trailer: '',
      episode_run_time: '',
      status: '',
    };

    const movieData = {
      stream_id: movie.externalId,
      name: movie.name,
      added: movie.addedAt ? String(Math.floor(movie.addedAt.getTime() / 1000)) : '',
      category_id: categoryId,
      category_ids: [categoryId],
      container_extension: movie.containerExtension ?? 'mp4',
      custom_sid: '',
      rating: movie.rating ?? '',
    };

    return { info, movie_data: movieData };
  }

  static series(serie: Series, categoryId: string): Record<string, unknown> {
    return {
      num: 0,
      name: serie.name,
      cover: serie.cover ?? '',
      plot: serie.plot ?? '',
      cast: serie.cast ?? '',
      genre: serie.genre ?? '',
      releaseDate: serie.releaseDate ?? '',
      lastModified: serie.releaseDate ?? '',
      rating: '',
      category_id: categoryId,
    };
  }

  static seriesInfo(
    serie: Series,
    episodes: SeriesEpisode[],
    categoryId: string,
  ): Record<string, unknown> {
    const bySeason = new Map<number, SeriesEpisode[]>();
    for (const episode of episodes) {
      const list = bySeason.get(episode.season) ?? [];
      list.push(episode);
      bySeason.set(episode.season, list);
    }

    const seasons = [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, list]) => ({
        air_date: '',
        episode_count: list.length,
        id: season,
        name: `Season ${season}`,
        overview: '',
        season_number: season,
        cover: serie.cover ?? '',
        cover_big: serie.cover ?? '',
      }));

    const episodesPayload: Record<string, unknown[]> = {};
    for (const [season, list] of bySeason) {
      episodesPayload[String(season)] = list.map((episode) => ({
        id: episode.externalId,
        episode_num: episode.episode,
        title: episode.title ?? `Episode ${episode.episode}`,
        container_extension: episode.containerExtension ?? 'mp4',
        info: {
          id: episode.externalId,
          name: episode.title ?? `Episode ${episode.episode}`,
          episode_num: episode.episode,
          season: episode.season,
          plot: episode.plot ?? '',
          duration_secs: episode.durationSec ? String(episode.durationSec) : '',
          duration: episode.durationSec ? `${Math.floor(episode.durationSec / 60)} min` : '',
          container_extension: episode.containerExtension ?? 'mp4',
          movie_image: episode.streamIcon ?? serie.cover ?? '',
          releasedate: serie.releaseDate ?? '',
          rating: '',
        },
      }));
    }

    return {
      seasons,
      info: {
        name: serie.name,
        cover: serie.cover ?? '',
        plot: serie.plot ?? '',
        cast: serie.cast ?? '',
        director: '',
        genre: serie.genre ?? '',
        releaseDate: serie.releaseDate ?? '',
        youtube_trailer: '',
        episode_run_time: '',
        category_id: categoryId,
        status: '',
      },
      episodes: episodesPayload,
    };
  }

  static epg(entries: EpgEntry[]): Record<string, unknown[]> {
    const byChannel = new Map<string, unknown[]>();

    for (const entry of entries) {
      const list = byChannel.get(entry.channelExternalId) ?? [];
      list.push({
        id: String(entry.id),
        epg_id: entry.channelExternalId,
        title: entry.title,
        lang: entry.lang ?? '',
        start: String(Math.floor(entry.startAt.getTime() / 1000)),
        stop: String(Math.floor(entry.stopAt.getTime() / 1000)),
        description: entry.description ?? '',
        channel_id: entry.channelExternalId,
        start_timestamp: String(Math.floor(entry.startAt.getTime() / 1000)),
        stop_timestamp: String(Math.floor(entry.stopAt.getTime() / 1000)),
      });
      byChannel.set(entry.channelExternalId, list);
    }

    return Object.fromEntries(byChannel);
  }

  static activeSessions(sessions: Array<{
    username: string;
    clientIp: string;
    startedAt: number;
    streamId: string;
    streamKind: StreamKindLabel;
    channelName?: string;
    bytes: number;
  }>): Array<Record<string, unknown>> {
    return sessions.map((session) => ({
      username: session.username,
      ip: session.clientIp,
      login_date: new Date(session.startedAt).toISOString(),
      stream_id: session.streamId,
      stream_title: session.channelName ?? session.streamId,
      stream_type: session.streamKind === 'live' ? 'live' : 'vod',
      stream_source: 'IPTV-Home-Gateway',
      duration: String(Math.round((Date.now() - session.startedAt) / 1000)),
      container_extension: 'ts',
      pid: 0,
      spid: 0,
      bytes: session.bytes,
    }));
  }
}
