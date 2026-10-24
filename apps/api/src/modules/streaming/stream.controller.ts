import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamEndReason } from '@prisma/client';
import { TicketAuthGuard } from '../../common/guards/ticket-auth.guard';
import { ContentService } from '../content/content.service';
import { ProvidersService } from '../providers/providers.service';
import { StreamKind } from '../providers/provider-adapter.port';
import { StreamingService } from './streaming.service';
import { HlsProxyService } from './hls-proxy.service';

interface ParsedTarget {
  streamId: string;
  extension: string;
}

/**
 * Streaming proxy.
 *
 * Routes (the extension is parsed manually to stay compatible with both
 * Express 4 and Express 5 path matching):
 *   GET /live/:username/:password/:streamId.ts
 *   GET /live/:username/:password/:streamId.m3u8
 *   GET /movie/:username/:password/:streamId.mp4
 *   GET /series/:username/:password/:streamId.mp4
 */
@Controller()
@UseGuards(TicketAuthGuard)
export class StreamController {
  constructor(
    private readonly streaming: StreamingService,
    private readonly content: ContentService,
    private readonly providers: ProvidersService,
    private readonly hls: HlsProxyService,
  ) {}

  @Get('live/:username/:password/:target')
  @Get('movie/:username/:password/:target')
  @Get('series/:username/:password/:target')
  async proxy(
    @Req() request: Request,
    @Res() response: Response,
    @Param('target') target: string,
  ) {
    const parsed = this.parseTarget(target);
    const ticket = request.ticket!;

    const kind =
      request.path.startsWith('/movie')
        ? 'vod'
        : request.path.startsWith('/series')
          ? 'episode'
          : 'live';

    if (parsed.extension === 'm3u8') {
      return this.serveHls(request, response, ticket, kind, parsed.streamId);
    }

    const ip = request.clientIp ?? request.ip ?? 'unknown';

    const { session } = await this.streaming.start({
      ticket,
      streamKind: kind,
      streamId: parsed.streamId,
      extension: parsed.extension,
      ip,
      userAgent: request.headers['user-agent'],
      res: response,
    });

    const cleanup = (reason: StreamEndReason) => {
      void this.streaming.end(session, reason);
    };

    response.on('close', () => cleanup(StreamEndReason.CLIENT_DISCONNECT));
    response.on('error', () => cleanup(StreamEndReason.CLIENT_DISCONNECT));

    // The response is written by the stream hub as soon as bytes arrive.
    // `@Res()` without `passthrough` tells Nest not to send anything itself,
    // which is mandatory for a long-lived stream.
    return undefined;
  }

  /**
   * Serves an HLS playlist whose segments are proxied through signed URLs.
   */
  private async serveHls(
    request: Request,
    response: Response,
    ticket: NonNullable<Request['ticket']>,
    kind: 'live' | 'vod' | 'episode',
    streamId: string,
  ): Promise<void> {
    try {
      const upstreamUrl = await this.resolveUpstreamUrl(ticket, kind, streamId, 'm3u8');
      const playlist = await this.hls.rewritePlaylist(upstreamUrl, ticket.username, ticket.password);

      response.status(200);
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.setHeader('Cache-Control', 'no-cache');
      response.end(playlist);
    } catch (error) {
      if (!response.headersSent) {
        response.status(HttpStatus.BAD_GATEWAY).json({
          statusCode: HttpStatus.BAD_GATEWAY,
          error: 'Bad Gateway',
          message: `Flux HLS indisponible: ${(error as Error).message}`,
        });
      } else {
        response.end();
      }
    }
  }

  private async resolveUpstreamUrl(
    ticket: NonNullable<Request['ticket']>,
    kind: 'live' | 'vod' | 'episode',
    streamId: string,
    extension: string,
  ): Promise<string> {
    const adapter = await this.providers.adapter(ticket.providerId);

    if (kind === 'live') {
      const channel = await this.content.liveChannel(
        { ticket, providerId: ticket.providerId },
        streamId,
      );
      if (!channel) throw new HttpException('Chaine introuvable', HttpStatus.NOT_FOUND);
      if (channel.streamUrl) return channel.streamUrl;
      return adapter.resolveStreamUrl(StreamKind.LIVE, channel.externalId, extension);
    }

    if (kind === 'vod') {
      const movie = await this.content.movie({ ticket, providerId: ticket.providerId }, streamId);
      if (!movie) throw new HttpException('Film introuvable', HttpStatus.NOT_FOUND);
      if (movie.streamUrl) return movie.streamUrl;
      return adapter.resolveStreamUrl(
        StreamKind.VOD,
        movie.externalId,
        movie.containerExtension ?? 'mp4',
      );
    }

    throw new HttpException('Type de flux non gere', HttpStatus.NOT_FOUND);
  }

  private parseTarget(target: string): ParsedTarget {
    const index = target.lastIndexOf('.');
    if (index <= 0) {
      return { streamId: target, extension: 'ts' };
    }
    return {
      streamId: target.slice(0, index),
      extension: target.slice(index + 1).toLowerCase(),
    };
  }
}

/**
 * Proxies a single HLS segment.
 * Kept in its own controller: the URL is signed, so it does not carry the
 * ticket credentials and must not go through the ticket guard.
 */
@Controller('hlsseg')
export class HlsSegmentController {
  constructor(private readonly hls: HlsProxyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async segment(@Req() request: Request, @Res() response: Response) {
    const query = request.query as Record<string, string | undefined>;
    const encoded = query.u ?? '';
    const signature = query.s ?? '';

    const upstreamUrl = this.hls.verify(encoded, signature);
    if (!upstreamUrl) {
      response.status(HttpStatus.FORBIDDEN).json({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        message: 'Segment invalide ou signature expiree.',
      });
      return;
    }

    response.status(200);
    response.setHeader('Content-Type', 'video/mp2t');
    response.setHeader('Cache-Control', 'no-store');

    await this.hls.pipeSegment(
      upstreamUrl,
      (chunk) => {
        if (!response.writableEnded) response.write(chunk);
      },
      () => {
        if (!response.writableEnded) response.end();
      },
      () => {
        if (!response.writableEnded) response.end();
      },
    );
  }
}
