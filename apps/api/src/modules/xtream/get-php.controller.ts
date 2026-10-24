import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TicketAuthGuard } from '../../common/guards/ticket-auth.guard';
import { ContentService } from '../content/content.service';
import { GatewayUrlService } from './gateway-url.service';

/**
 * `get.php` — dynamic M3U playlist.
 *
 * The generated playlist only contains gateway URLs: the upstream server is
 * never exposed to the client.
 */
@Controller('get.php')
@UseGuards(TicketAuthGuard)
export class GetPhpController {
  constructor(
    private readonly content: ContentService,
    private readonly urls: GatewayUrlService,
  ) {}

  @Get()
  @Header('Content-Type', 'audio/x-mpegurl; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async playlist(@Req() request: Request, @Query() query: Record<string, string>) {
    const ticket = request.ticket!;
    const scope = await this.content.scopeForTicket(ticket);
    const type = (query.type ?? 'm3u_plus').toLowerCase();
    const output = (query.output ?? 'ts').toLowerCase();
    const extension = output === 'm3u8' ? 'm3u8' : 'ts';

    const lines: string[] = ['#EXTM3U'];

    const channels = await this.content.liveChannels(scope);
    const categories = await this.content.categories(scope, 'LIVE' as never);
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));

    for (const channel of channels) {
      const url = this.urls.live(ticket.username, ticket.password, channel.externalId, extension);
      const group = categoryById.get(channel.categoryId ?? '') ?? 'Divers';

      if (type === 'm3u') {
        lines.push(`#EXTINF:-1,${channel.name}`);
      } else {
        const attributes = [
          channel.epgChannelId ? `tvg-id="${channel.epgChannelId}"` : '',
          channel.epgChannelId ? `tvg-chno="${channel.epgChannelId}"` : '',
          `tvg-name="${channel.name}"`,
          channel.streamIcon ? `tvg-logo="${channel.streamIcon}"` : '',
          `group-title="${group}"`,
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(`#EXTINF:-1 ${attributes},${channel.name}`);
      }
      lines.push(url);
    }

    return lines.join('\n');
  }
}
