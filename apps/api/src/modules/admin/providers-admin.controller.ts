import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OverflowPolicy, ProviderKind, SyncKind } from '@prisma/client';
import {
  IsBoolean,
  IsBooleanString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ProvidersService } from '../providers/providers.service';
import { ContentService } from '../content/content.service';
import { ConnectionRegistryService } from '../connections/connection-registry.service';

class CreateProviderDto {
  @IsString()
  name!: string;

  @IsEnum(ProviderKind)
  kind!: ProviderKind;

  @IsString()
  baseUrl!: string;

  @IsOptional()
  @IsString()
  playlistUrl?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxConnections?: number;

  @IsOptional()
  @IsEnum(OverflowPolicy)
  overflowPolicy?: OverflowPolicy;

  @IsOptional()
  @IsInt()
  @Min(60)
  maxRefreshIntervalSec?: number;

  @IsOptional()
  @IsString()
  epgUrl?: string;

  @IsOptional()
  @IsObject()
  extraHeaders?: Record<string, string>;

  @IsOptional()
  @IsBooleanString()
  isEnabled?: boolean;
}

class UpdateProviderDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  playlistUrl?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxConnections?: number;

  @IsOptional()
  @IsEnum(OverflowPolicy)
  overflowPolicy?: OverflowPolicy;

  @IsOptional()
  @IsInt()
  @Min(60)
  refreshIntervalSec?: number;

  @IsOptional()
  @IsString()
  epgUrl?: string;

  @IsOptional()
  @IsObject()
  extraHeaders?: Record<string, string>;

  @IsOptional()
  @IsBooleanString()
  isEnabled?: boolean;
}

/**
 * Administration of the upstream source(s).
 *
 * A provider may be a genuine Xtream Codes panel or a plain M3U playlist:
 * both are exposed identically to the clients.
 */
@Controller('api/admin/providers')
@UseGuards(AdminAuthGuard)
export class ProvidersAdminController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly content: ContentService,
    private readonly registry: ConnectionRegistryService,
  ) {}

  @Get()
  async list() {
    const items = await this.providers.list();
    const withUsage = await Promise.all(
      items.map(async (provider) => {
        const feeds = await this.registry.listProviderFeeds(provider.id);
        return {
          ...provider,
          activeFeeds: feeds.length,
          liveFeeds: feeds.map((feed) => ({
            feedKey: feed.feedKey,
            streamId: feed.streamId,
            clients: feed.clients,
            startedAt: new Date(feed.startedAt).toISOString(),
            bytes: feed.bytes,
          })),
        };
      }),
    );
    return { items: withUsage };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.providers.get(id);
  }

  @Post()
  async create(@Body() body: CreateProviderDto) {
    return this.providers.create({
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl,
      playlistUrl: body.playlistUrl,
      username: body.username,
      password: body.password,
      maxConnections: body.maxConnections,
      overflowPolicy: body.overflowPolicy,
      refreshIntervalSec: body.maxRefreshIntervalSec,
      epgUrl: body.epgUrl,
      extraHeaders: body.extraHeaders,
      isEnabled: body.isEnabled,
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateProviderDto) {
    return this.providers.update(id, {
      name: body.name,
      baseUrl: body.baseUrl,
      playlistUrl: body.playlistUrl,
      username: body.username,
      password: body.password,
      maxConnections: body.maxConnections,
      overflowPolicy: body.overflowPolicy,
      refreshIntervalSec: body.refreshIntervalSec,
      epgUrl: body.epgUrl,
      extraHeaders: body.extraHeaders,
      isEnabled: body.isEnabled,
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.providers.remove(id);
    return { deleted: true };
  }

  /** Tests the upstream connection and refreshes `max_connections`. */
  @Post(':id/test')
  async test(@Param('id') id: string) {
    const health = await this.providers.testConnection(id);
    const provider = await this.providers.get(id);
    return { ...health, provider };
  }

  /** Triggers a catalogue synchronisation. */
  @Post(':id/sync')
  async sync(
    @Param('id') id: string,
    @Query('kind') kind?: SyncKind,
  ) {
    await this.content.syncProvider(id, kind ?? SyncKind.FULL);
    return { synced: true, kind: kind ?? SyncKind.FULL };
  }

  /** Categories of a provider (used by the category filter in the UI). */
  @Get(':id/categories')
  async categories(@Param('id') id: string) {
    const scope = { ticket: null as never, providerId: id };
    const [live, vod, series] = await Promise.all([
      this.content.categories(scope, 'LIVE' as never),
      this.content.categories(scope, 'VOD' as never),
      this.content.categories(scope, 'SERIES' as never),
    ]);
    return { live, vod, series };
  }
}
