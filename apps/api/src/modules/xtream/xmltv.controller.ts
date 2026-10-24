import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TicketAuthGuard } from '../../common/guards/ticket-auth.guard';
import { ContentService } from '../content/content.service';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * `xmltv.php` — EPG in XMLTV format, consumed by most IPTV applications.
 */
@Controller('xmltv.php')
@UseGuards(TicketAuthGuard)
export class XmltvController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async epg(@Req() request: Request, @Query() query: Record<string, string>) {
    const ticket = request.ticket!;
    const scope = await this.content.scopeForTicket(ticket);

    const channels = await this.content.liveChannels(scope);
    const entries = await this.content.epg(scope, {
      channelId: query.channel_id ?? query.stream_id,
    });

    const knownChannels = new Set(channels.map((channel) => channel.externalId));
    const byId = new Map(channels.map((channel) => [channel.externalId, channel]));

    const parts: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      '<tv generator-info-name="IPTV Home Gateway" generator-info-url="">',
    ];

    for (const channel of channels) {
      const id = channel.epgChannelId || channel.externalId;
      parts.push(`  <channel id="${escapeXml(id)}">`);
      parts.push(`    <display-name>${escapeXml(channel.name)}</display-name>`);
      if (channel.streamIcon) {
        parts.push(`    <icon src="${escapeXml(channel.streamIcon)}" />`);
      }
      parts.push('  </channel>');
    }

    for (const entry of entries) {
      const channel = byId.get(entry.channelExternalId);
      const channelId = channel?.epgChannelId || entry.channelExternalId;
      if (channel && !knownChannels.has(entry.channelExternalId)) continue;

      const start = this.formatXmltvTime(entry.startAt);
      const stop = this.formatXmltvTime(entry.stopAt);

      parts.push(`  <programme start="${start}" stop="${stop}" channel="${escapeXml(channelId)}">`);
      parts.push(`    <title lang="fr">${escapeXml(entry.title)}</title>`);
      if (entry.description) {
        parts.push(`    <desc lang="fr">${escapeXml(entry.description)}</desc>`);
      }
      parts.push('  </programme>');
    }

    parts.push('</tv>');
    return parts.join('\n');
  }

  private formatXmltvTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return (
      `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
    );
  }
}
