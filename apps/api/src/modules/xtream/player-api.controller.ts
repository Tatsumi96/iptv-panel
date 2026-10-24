import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TicketAuthGuard } from '../../common/guards/ticket-auth.guard';
import { ContentService, CatalogueScope } from '../content/content.service';
import { ConnectionRegistryService } from '../connections/connection-registry.service';
import { GatewayUrlService } from './gateway-url.service';
import { XtreamMapper } from './xtream.mapper';

/**
 * `player_api.php` — the endpoint every Xtream-compatible app calls.
 *
 * Supported actions:
 *   (none)                -> user_info + server_info + available_channels
 *   get_live_categories   -> live category tree
 *   get_vod_categories    -> VOD category tree
 *   get_series_categories -> series category tree
 *   get_live_streams      -> live channels (optionally filtered by category_id)
 *   get_vod_streams       -> movies
 *   get_series            -> series list
 *   get_series_info       -> seasons + episodes of a series
 *   get_vod_info          -> details of a movie
 *   get_epg / get_epg_by_id -> programme guide
 *   get_active_sessions   -> currently connected devices
 *   get_simple_data_table -> summary counters
 */
@Controller('player_api.php')
@UseGuards(TicketAuthGuard)
export class PlayerApiController {
  constructor(
    private readonly content: ContentService,
    private readonly registry: ConnectionRegistryService,
    private readonly urls: GatewayUrlService,
  ) {}

  @Get()
  async handle(@Req() request: Request, @Query() query: Record<string, string>) {
    const ticket = request.ticket!;
    const scope = await this.content.scopeForTicket(ticket);
    const action = (query.action ?? '').trim();

    switch (action) {
      case 'get_live_categories':
        return this.categories(scope, 'LIVE');
      case 'get_vod_categories':
        return this.categories(scope, 'VOD');
      case 'get_series_categories':
        return this.categories(scope, 'SERIES');
      case 'get_live_streams':
        return this.liveStreams(scope, ticket.username, ticket.password, query.category_id);
      case 'get_vod_streams':
        return this.vodStreams(scope, ticket.username, ticket.password, query.category_id);
      case 'get_series':
        return this.series(scope, query.category_id);
      case 'get_series_info':
        return this.seriesInfo(scope, query.series_id);
      case 'get_vod_info':
        return this.vodInfo(scope, query.vod_id);
      case 'get_epg':
        return this.epg(scope, query.channel_id ?? query.stream_id);
      case 'get_epg_by_id':
        return this.epg(scope, query.id ?? query.channel_id);
      case 'get_active_sessions':
        return this.activeSessions(ticket.id);
      case 'get_simple_data_table':
        return this.simpleDataTable(scope);
      case '':
      case 'get_account_info':
        return this.accountInfo(scope, ticket.username);
      default:
        return this.accountInfo(scope, ticket.username);
    }
  }

  // -------------------------------------------------------------------------

  private async accountInfo(scope: CatalogueScope, username: string) {
    const ticket = scope.ticket;
    const sessions = await this.registry.listTicketSessions(ticket.id);

    return {
      user_info: XtreamMapper.userInfo({
        username,
        password: ticket.password,
        status: 'active',
        expiresAt: ticket.expiresAt,
        maxConnections: ticket.maxConnections,
        activeConnections: sessions.length,
        createdAt: ticket.createdAt,
      }),
      server_info: XtreamMapper.serverInfo(this.urls.baseUrl),
      available_channels: await this.availableChannels(scope),
    };
  }

  private async availableChannels(scope: CatalogueScope) {
    const channels = await this.content.liveChannels(scope);
    const categories = await this.content.categories(scope, 'LIVE' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));

    const result: Record<string, unknown> = {};
    channels.forEach((channel, index) => {
      result[String(channel.externalId)] = XtreamMapper.channel(
        channel,
        this.urls.live(scope.ticket.username, scope.ticket.password, channel.externalId),
        categoryById.get(channel.categoryId ?? '') ?? '',
        index + 1,
      );
    });
    return result;
  }

  private async categories(scope: CatalogueScope, kind: 'LIVE' | 'VOD' | 'SERIES') {
    const categories = await this.content.categories(scope, kind as never);
    return categories.map((category) => XtreamMapper.category(category));
  }

  private async liveStreams(
    scope: CatalogueScope,
    username: string,
    password: string,
    categoryId?: string,
  ) {
    const channels = await this.content.liveChannels(scope, categoryId);
    const categories = await this.content.categories(scope, 'LIVE' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));

    return channels.map((channel, index) =>
      XtreamMapper.channel(
        channel,
        this.urls.live(username, password, channel.externalId),
        categoryById.get(channel.categoryId ?? '') ?? '',
        index + 1,
      ),
    );
  }

  private async vodStreams(
    scope: CatalogueScope,
    username: string,
    password: string,
    categoryId?: string,
  ) {
    const movies = await this.content.movies(scope, categoryId);
    const categories = await this.content.categories(scope, 'VOD' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));

    return movies.map((movie) =>
      XtreamMapper.movie(
        movie,
        categoryById.get(movie.categoryId ?? '') ?? '',
        this.urls.vod(username, password, movie.externalId, movie.containerExtension ?? 'mp4'),
      ),
    );
  }

  private async series(scope: CatalogueScope, categoryId?: string) {
    const list = await this.content.seriesList(scope, categoryId);
    const categories = await this.content.categories(scope, 'SERIES' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));
    return list.map((serie) =>
      XtreamMapper.series(serie, categoryById.get(serie.categoryId ?? '') ?? ''),
    );
  }

  private async seriesInfo(scope: CatalogueScope, seriesId?: string) {
    if (!seriesId) return { seasons: [], info: {}, episodes: {} };
    const serie = await this.content.seriesById(scope, seriesId);
    if (!serie) return { seasons: [], info: {}, episodes: {} };

    const episodes = await this.content.seriesEpisodes(serie.id);
    const categories = await this.content.categories(scope, 'SERIES' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));

    return XtreamMapper.seriesInfo(
      serie,
      episodes,
      categoryById.get(serie.categoryId ?? '') ?? '',
    );
  }

  private async vodInfo(scope: CatalogueScope, vodId?: string) {
    if (!vodId) return { info: {}, movie_data: {} };
    const movie = await this.content.movie(scope, vodId);
    if (!movie) return { info: {}, movie_data: {} };

    const categories = await this.content.categories(scope, 'VOD' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.externalId]));
    return XtreamMapper.movieDetail(movie, categoryById.get(movie.categoryId ?? '') ?? '');
  }

  private async epg(scope: CatalogueScope, channelId?: string) {
    const entries = await this.content.epg(scope, { channelId });
    return XtreamMapper.epg(entries);
  }

  private async activeSessions(ticketId: string) {
    const sessions = await this.registry.listTicketSessions(ticketId);
    return XtreamMapper.activeSessions(sessions);
  }

  private async simpleDataTable(scope: CatalogueScope) {
    const [channels, movies, series] = await Promise.all([
      this.content.liveChannels(scope),
      this.content.movies(scope),
      this.content.seriesList(scope),
    ]);

    return {
      total: channels.length + movies.length + series.length,
      live: channels.length,
      vod: movies.length,
      series: series.length,
      max: 0,
      stream_id: '',
      name: '',
      added: '',
      category_id: '',
      container_extension: '',
    };
  }
}
