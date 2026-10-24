import { Injectable, Logger } from '@nestjs/common';
import {
  CategoryKind,
  Channel,
  EpgEntry,
  Movie,
  Prisma,
  Series,
  SeriesEpisode,
  SyncKind,
  Ticket,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProvidersService } from '../providers/providers.service';
import {
  StreamKind,
  UpstreamCategory,
  UpstreamChannel,
  UpstreamEpg,
  UpstreamMovie,
  UpstreamSeries,
  UpstreamSeriesInfo,
} from '../providers/provider-adapter.port';

export interface CatalogueScope {
  /** Ticket the request belongs to (used to build the gateway URLs). */
  ticket: Ticket;
  providerId: string;
  /** When defined, only these category ids are visible to the ticket. */
  allowedCategoryIds?: string[];
  useCategoryFilter?: boolean;
}

const CACHE_TTL_MS = 20_000;
const UPSERT_CHUNK = 200;
/**
 * Maximum number of ids bound to a single statement.
 * PostgreSQL caps the number of bind variables at 32767, and a `notIn` list
 * of 150k catalogue entries blows that limit.
 */
const DELETE_CHUNK = 5_000;
/** Number of rows read per page when computing the stale entries. */
const SCAN_PAGE = 5_000;

/**
 * Catalogue of the gateway.
 *
 * Whatever the source (Xtream panel or raw M3U playlist), the content is
 * normalised into the same tables and served from there. The Xtream-compatible
 * endpoints read exclusively from this service, which is what makes an M3U
 * source behave exactly like a native Xtream provider.
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
  ) {}

  invalidateCache(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return Promise.resolve(hit.value as T);
    }
    return factory().then((value) => {
      this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    });
  }

  // -------------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------------

  async syncProvider(providerId: string, kind: SyncKind = SyncKind.FULL): Promise<void> {
    const provider = await this.providers.getRaw(providerId);
    const adapter = await this.providers.adapter(providerId);

    const run = await this.prisma.syncRun.create({
      data: { providerId, kind, startedAt: new Date() },
    });

    try {
      const stats: Record<string, number> = {};

      if (kind === SyncKind.FULL || kind === SyncKind.CONTENT) {
        const categories = await this.syncCategories(providerId, adapter);
        stats.categories = categories;

        const channels = await this.syncChannels(providerId, adapter);
        stats.channels = channels;

        const movies = await this.syncMovies(providerId, adapter);
        stats.movies = movies;

        const series = await this.syncSeries(providerId, adapter);
        stats.series = series;
      }

      if (kind === SyncKind.FULL || kind === SyncKind.EPG) {
        const epg = await this.syncEpg(providerId, adapter);
        stats.epg = epg;
      }

      await this.prisma.upstreamProvider.update({
        where: { id: providerId },
        data: { lastSyncedAt: new Date(), status: 'ONLINE', lastError: null },
      });

      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          ok: true,
          stats: stats as Prisma.InputJsonValue,
        },
      });

      this.invalidateCache();
      this.logger.log(`Sync ${provider.name}: ${JSON.stringify(stats)}`);
    } catch (error) {
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          ok: false,
          message: (error as Error).message,
        },
      });
      await this.providers.getRaw(providerId);
      throw error;
    }
  }

  private async syncCategories(
    providerId: string,
    adapter: Awaited<ReturnType<ProvidersService['adapter']>>,
  ): Promise<number> {
    const kinds: CategoryKind[] = [CategoryKind.LIVE, CategoryKind.VOD, CategoryKind.SERIES];
    let total = 0;

    for (const kind of kinds) {
      const upstream = await adapter.categories(kind);
      total += upstream.length;

      for (const chunk of chunkArray(upstream, UPSERT_CHUNK)) {
        await this.prisma.$transaction(
          chunk.map((category) =>
            this.prisma.category.upsert({
              where: {
                providerId_kind_externalId: {
                  providerId,
                  kind,
                  externalId: category.categoryId,
                },
              },
              create: {
                providerId,
                kind,
                externalId: category.categoryId,
                name: category.categoryName,
                parentExternalId: category.parentId ?? null,
                sortOrder: category.sortOrder ?? 0,
              },
              update: {
                name: category.categoryName,
                parentExternalId: category.parentId ?? null,
                sortOrder: category.sortOrder ?? 0,
              },
            }),
          ),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      }

      // Remove categories that disappeared upstream.
      const keep = upstream.map((c) => c.categoryId);
      await this.deleteStale('category', providerId, keep, { kind });
    }

    return total;
  }

  private async syncChannels(
    providerId: string,
    adapter: Awaited<ReturnType<ProvidersService['adapter']>>,
  ): Promise<number> {
    const upstream = await adapter.liveStreams();
    const categoryMap = await this.categoryMap(providerId);

    for (const chunk of chunkArray(upstream, UPSERT_CHUNK)) {
      await this.prisma.$transaction(
        chunk.map((channel) =>
          this.prisma.channel.upsert({
            where: {
              providerId_externalId: { providerId, externalId: channel.streamId },
            },
            create: {
              providerId,
              externalId: channel.streamId,
              name: channel.name,
              categoryId: categoryMap.get(channel.categoryId) ?? null,
              tvgId: channel.epgChannelId ?? null,
              epgChannelId: channel.epgChannelId ?? null,
              streamIcon: channel.streamIcon ?? null,
              streamType: channel.streamType ?? 'live',
              order: channel.num ?? 0,
              timeshift: Boolean(channel.tvArchive),
              tvArchiveDuration: channel.tvArchiveDuration ?? null,
              streamUrl: channel.directSource ?? null,
            },
            update: {
              name: channel.name,
              categoryId: categoryMap.get(channel.categoryId) ?? null,
              tvgId: channel.epgChannelId ?? null,
              epgChannelId: channel.epgChannelId ?? null,
              streamIcon: channel.streamIcon ?? null,
              streamType: channel.streamType ?? 'live',
              order: channel.num ?? 0,
              timeshift: Boolean(channel.tvArchive),
              tvArchiveDuration: channel.tvArchiveDuration ?? null,
              streamUrl: channel.directSource ?? null,
            },
          }),
        ),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    }

    const keep = upstream.map((c) => c.streamId);
    await this.deleteStale('channel', providerId, keep);

    return upstream.length;
  }

  private async syncMovies(
    providerId: string,
    adapter: Awaited<ReturnType<ProvidersService['adapter']>>,
  ): Promise<number> {
    const upstream = await adapter.vodStreams();
    const categoryMap = await this.categoryMap(providerId);

    for (const chunk of chunkArray(upstream, UPSERT_CHUNK)) {
      await this.prisma.$transaction(
        chunk.map((movie) =>
          this.prisma.movie.upsert({
            where: {
              providerId_externalId: { providerId, externalId: movie.streamId },
            },
            create: {
              providerId,
              externalId: movie.streamId,
              name: movie.name,
              categoryId: categoryMap.get(movie.categoryId) ?? null,
              streamIcon: movie.streamIcon ?? null,
              rating: movie.rating ?? null,
              releaseYear: movie.releaseYear ? Number(movie.releaseYear) : null,
              plot: movie.plot ?? null,
              containerExtension: movie.containerExtension ?? null,
              durationSec: movie.duration ?? null,
              addedAt: movie.added ? new Date(Number(movie.added) * 1000) : null,
            },
            update: {
              name: movie.name,
              categoryId: categoryMap.get(movie.categoryId) ?? null,
              streamIcon: movie.streamIcon ?? null,
              rating: movie.rating ?? null,
              releaseYear: movie.releaseYear ? Number(movie.releaseYear) : null,
              plot: movie.plot ?? null,
              containerExtension: movie.containerExtension ?? null,
              durationSec: movie.duration ?? null,
            },
          }),
        ),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    }

    const keep = upstream.map((m) => m.streamId);
    await this.deleteStale('movie', providerId, keep);

    return upstream.length;
  }

  private async syncSeries(
    providerId: string,
    adapter: Awaited<ReturnType<ProvidersService['adapter']>>,
  ): Promise<number> {
    const upstream = await adapter.series();
    const categoryMap = await this.categoryMap(providerId);

    for (const chunk of chunkArray(upstream, UPSERT_CHUNK)) {
      await this.prisma.$transaction(
        chunk.map((serie) => {
          const externalId = String(serie.num);
          return this.prisma.series.upsert({
            where: { providerId_externalId: { providerId, externalId } },
            create: {
              providerId,
              externalId,
              name: serie.name,
              categoryId: categoryMap.get(serie.categoryId) ?? null,
              cover: serie.cover ?? null,
              plot: serie.plot ?? null,
              cast: serie.cast ?? null,
              genre: serie.genre ?? null,
              releaseDate: serie.releaseDate ?? null,
            },
            update: {
              name: serie.name,
              categoryId: categoryMap.get(serie.categoryId) ?? null,
              cover: serie.cover ?? null,
              plot: serie.plot ?? null,
              cast: serie.cast ?? null,
              genre: serie.genre ?? null,
              releaseDate: serie.releaseDate ?? null,
            },
          });
        }),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    }

    return upstream.length;
  }

  async syncEpg(
    providerId: string,
    adapter: Awaited<ReturnType<ProvidersService['adapter']>>,
  ): Promise<number> {
    const upstream = await adapter.epg();
    const channelMap = await this.epgChannelMap(providerId);

    const rows: Prisma.EpgEntryCreateManyInput[] = upstream
      .filter((entry) => entry.title)
      .map((entry) => ({
        providerId,
        channelExternalId: channelMap.get(entry.channelId) ?? entry.channelId,
        channelId: channelMap.get(entry.channelId) ?? null,
        title: entry.title,
        description: entry.description ?? null,
        lang: entry.lang ?? null,
        startAt: new Date(entry.start * 1000),
        stopAt: new Date(entry.stop * 1000),
      }));

    // Replace the whole EPG window for the provider: simpler and always consistent.
    await this.prisma.epgEntry.deleteMany({
      where: {
        providerId,
        stopAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });

    for (const chunk of chunkArray(rows, 500)) {
      await this.prisma.epgEntry.createMany({ data: chunk, skipDuplicates: true });
    }

    return rows.length;
  }

  private async categoryMap(
    providerId: string,
  ): Promise<Map<string, string>> {
    const categories = await this.prisma.category.findMany({
      where: { providerId },
      select: { id: true, externalId: true, kind: true },
    });
    const map = new Map<string, string>();
    for (const category of categories) {
      map.set(`${category.kind}:${category.externalId}`, category.id);
    }
    // Live channels are matched against LIVE categories.
    const live = categories.filter((c) => c.kind === CategoryKind.LIVE);
    for (const category of live) map.set(category.externalId, category.id);
    return map;
  }

  private async epgChannelMap(providerId: string): Promise<Map<string, string>> {
    const channels = await this.prisma.channel.findMany({
      where: { providerId },
      select: { id: true, externalId: true, epgChannelId: true, tvgId: true },
    });
    const map = new Map<string, string>();
    for (const channel of channels) {
      if (channel.epgChannelId) map.set(channel.epgChannelId, channel.id);
      if (channel.tvgId) map.set(channel.tvgId, channel.id);
      map.set(channel.externalId, channel.id);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async categories(scope: CatalogueScope, kind: CategoryKind) {
    const key = `cat:${scope.providerId}:${kind}:${scope.useCategoryFilter ? scope.allowedCategoryIds?.join(',') ?? '*' : '*'}`;
    return this.cached(key, async () => {
      const where: Prisma.CategoryWhereInput = { providerId: scope.providerId, kind };
      if (scope.useCategoryFilter && scope.allowedCategoryIds?.length) {
        where.id = { in: scope.allowedCategoryIds };
      }
      return this.prisma.category.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
    });
  }

  async liveChannels(scope: CatalogueScope, categoryExternalId?: string) {
    const key = `live:${scope.providerId}:${categoryExternalId ?? '*'}:${scope.useCategoryFilter ? scope.allowedCategoryIds?.join(',') ?? '*' : '*'}`;
    return this.cached(key, async () => {
      const where: Prisma.ChannelWhereInput = { providerId: scope.providerId };
      if (categoryExternalId) {
        where.category = { externalId: categoryExternalId };
      }
      if (scope.useCategoryFilter) {
        const ids = scope.allowedCategoryIds ?? [];
        where.categoryId = ids.length ? { in: ids } : null;
      }
      return this.prisma.channel.findMany({
        where,
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
      });
    });
  }

  async liveChannel(scope: CatalogueScope, streamId: string): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: { providerId: scope.providerId, externalId: streamId },
    });
  }

  async movies(scope: CatalogueScope, categoryExternalId?: string) {
    const key = `vod:${scope.providerId}:${categoryExternalId ?? '*'}:${scope.useCategoryFilter ? scope.allowedCategoryIds?.join(',') ?? '*' : '*'}`;
    return this.cached(key, async () => {
      const where: Prisma.MovieWhereInput = { providerId: scope.providerId };
      if (categoryExternalId) {
        where.category = { externalId: categoryExternalId };
      }
      if (scope.useCategoryFilter) {
        const ids = scope.allowedCategoryIds ?? [];
        where.categoryId = ids.length ? { in: ids } : null;
      }
      return this.prisma.movie.findMany({
        where,
        orderBy: [{ name: 'asc' }],
      });
    });
  }

  async movie(scope: CatalogueScope, vodId: string): Promise<Movie | null> {
    return this.prisma.movie.findFirst({
      where: { providerId: scope.providerId, externalId: vodId },
    });
  }

  async seriesList(scope: CatalogueScope, categoryExternalId?: string) {
    const key = `series:${scope.providerId}:${categoryExternalId ?? '*'}:${scope.useCategoryFilter ? scope.allowedCategoryIds?.join(',') ?? '*' : '*'}`;
    return this.cached(key, async () => {
      const where: Prisma.SeriesWhereInput = { providerId: scope.providerId };
      if (categoryExternalId) {
        where.category = { externalId: categoryExternalId };
      }
      if (scope.useCategoryFilter) {
        const ids = scope.allowedCategoryIds ?? [];
        where.categoryId = ids.length ? { in: ids } : null;
      }
      return this.prisma.series.findMany({
        where,
        orderBy: [{ name: 'asc' }],
      });
    });
  }

  async seriesById(scope: CatalogueScope, seriesId: string): Promise<Series | null> {
    return this.prisma.series.findFirst({
      where: { providerId: scope.providerId, externalId: seriesId },
    });
  }

  async seriesEpisodes(seriesId: string): Promise<SeriesEpisode[]> {
    return this.prisma.seriesEpisode.findMany({
      where: { seriesId },
      orderBy: [{ season: 'asc' }, { episode: 'asc' }],
    });
  }

  async episode(seriesId: string, episodeId: string): Promise<SeriesEpisode | null> {
    return this.prisma.seriesEpisode.findFirst({
      where: { seriesId, externalId: episodeId },
    });
  }

  async epg(
    scope: CatalogueScope,
    options: { channelId?: string; date?: Date; limit?: number } = {},
  ): Promise<EpgEntry[]> {
    const start = options.date
      ? new Date(options.date.getTime() - 24 * 3600 * 1000)
      : new Date(Date.now() - 12 * 3600 * 1000);
    const end = options.date
      ? new Date(options.date.getTime() + 48 * 3600 * 1000)
      : new Date(Date.now() + 36 * 3600 * 1000);

    const where: Prisma.EpgEntryWhereInput = {
      providerId: scope.providerId,
      startAt: { gte: start, lte: end },
    };

    if (options.channelId) {
      const channel = await this.liveChannel(scope, options.channelId);
      if (channel) {
        where.channelExternalId = channel.externalId;
      } else {
        where.channelExternalId = options.channelId;
      }
    }

    return this.prisma.epgEntry.findMany({
      where,
      orderBy: { startAt: 'asc' },
      take: options.limit ?? 2000,
    });
  }

  /**
   * Builds the scope of a ticket: which categories it may see.
   */
  async scopeForTicket(ticket: Ticket): Promise<CatalogueScope> {
    if (!ticket.useCategoryFilter) {
      return { ticket, providerId: ticket.providerId };
    }
    const links = await this.prisma.ticketCategory.findMany({
      where: { ticketId: ticket.id },
      select: { categoryId: true },
    });
    return {
      ticket,
      providerId: ticket.providerId,
      useCategoryFilter: true,
      allowedCategoryIds: links.map((link) => link.categoryId),
    };
  }

  /**
   * Deletes the rows of a content table that no longer exist upstream.
   *
   * The stale set is computed by diffing the stored external ids against the
   * upstream ones, then deleted in bounded chunks. Passing the whole upstream
   * list to a `notIn` filter is not an option: a 150k catalogue exceeds the
   * 32767 bind variables PostgreSQL accepts per statement.
   */
  private async deleteStale<TModel extends 'category' | 'channel' | 'movie' | 'series'>(
    model: TModel,
    providerId: string,
    keep: string[],
    extraWhere: Prisma.CategoryWhereInput = {},
  ): Promise<number> {
    const keepSet = new Set(keep);
    const delegate = this.prisma[model] as unknown as {
      findMany(args: {
        where: Prisma.CategoryWhereInput;
        select: { id: true; externalId: true };
        orderBy: { id: 'asc' };
        take: number;
        cursor?: { id: string };
        skip?: number;
      }): Promise<Array<{ id: string; externalId: string }>>;
      deleteMany(args: { where: Prisma.CategoryWhereInput }): Promise<{ count: number }>;
    };

    const stale: string[] = [];
    let cursor: string | undefined;
    // Cursor pagination over the stored rows: the table can hold hundreds of
    // thousands of entries and loading them all at once is not acceptable.
    for (;;) {
      const rows = await delegate.findMany({
        where: { providerId, ...extraWhere },
        select: { id: true, externalId: true },
        orderBy: { id: 'asc' },
        take: SCAN_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        if (!keepSet.has(row.externalId)) stale.push(row.externalId);
      }

      cursor = rows[rows.length - 1].id;
      if (rows.length < SCAN_PAGE) break;
    }

    if (stale.length === 0) return 0;

    let deleted = 0;
    for (const chunk of chunkArray(stale, DELETE_CHUNK)) {
      const result = await delegate.deleteMany({
        where: { providerId, externalId: { in: chunk }, ...extraWhere },
      });
      deleted += result.count;
    }
    return deleted;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
