import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OverflowPolicy, StreamEndReason, Ticket } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProvidersService } from '../providers/providers.service';
import { StreamKind } from '../providers/provider-adapter.port';
import {
  ConnectionRegistryService,
  SessionRecord,
  StreamKindLabel,
} from '../connections/connection-registry.service';
import {
  evaluateTicketLimit,
  evaluateUpstreamLimit,
  sharesUpstreamFeed,
} from '../connections/connection-limits';
import { StreamHubService } from './stream-hub.service';

export interface StartStreamParams {
  ticket: Ticket;
  streamKind: StreamKindLabel;
  streamId: string;
  extension?: string;
  ip: string;
  userAgent?: string;
  res: Response;
}

export interface StartedStream {
  session: SessionRecord;
  feedKey: string;
}

/**
 * Orchestrates the streaming lifecycle:
 *  - resolves the upstream URL for the requested item;
 *  - enforces the per-ticket connection limit;
 *  - enforces the upstream account limit (never exceeded);
 *  - attaches the client to the shared feed;
 *  - records the session for the dashboard and the logs.
 */
@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
    private readonly registry: ConnectionRegistryService,
    private readonly hub: StreamHubService,
  ) {}

  async start(params: StartStreamParams): Promise<StartedStream> {
    const { ticket } = params;

    const upstreamUrl = await this.resolveUpstreamUrl(params);

    const provider = await this.providers.getRaw(ticket.providerId);
    const feedKey = this.hub.feedKey(provider.id, params.streamKind, params.streamId);

    // ---- 1. Ticket connection limit -------------------------------------
    await this.enforceTicketLimit(ticket);

    // ---- 2. Upstream connection limit -----------------------------------
    await this.enforceUpstreamLimit(provider.id, provider.maxConnections, feedKey, provider.overflowPolicy);

    // ---- 3. Attach to the shared feed -----------------------------------
    const clientId = randomUUID();
    const session: SessionRecord = {
      id: clientId,
      ticketId: ticket.id,
      ticketLabel: ticket.label,
      username: ticket.username,
      providerId: provider.id,
      providerName: provider.name,
      streamId: params.streamId,
      streamKind: params.streamKind,
      channelName: await this.resolveDisplayName(params),
      clientIp: params.ip,
      userAgent: params.userAgent,
      startedAt: Date.now(),
      lastBeat: Date.now(),
      bytes: 0,
      feedKey,
    };

    const feed = await this.hub.attach({
      providerId: provider.id,
      providerName: provider.name,
      streamId: params.streamId,
      streamKind: params.streamKind,
      upstreamUrl,
      client: { id: clientId, session, res: params.res, attachedAt: Date.now(), headersSent: false },
    }).catch(async (error: Error) => {
      // The upstream slot was reserved for a feed that will never exist:
      // give it back, otherwise the account limit is reached for good.
      await this.registry.releaseProviderSlot(provider.id);
      throw error;
    });

    session.feedKey = feed.key;

    await this.registry.registerSession(session);
    await this.registry.registerFeed(this.hub.toFeedRecord(feed));

    this.logger.log(
      `Flux ouvert: ${ticket.label} -> ${session.channelName ?? params.streamId} (${params.ip})`,
    );

    // Persist the log entry asynchronously: never block the stream for it.
    void this.prisma.streamLog
      .create({
        data: {
          ticketId: ticket.id,
          providerId: provider.id,
          channelName: session.channelName ?? null,
          streamId: params.streamId,
          clientIp: params.ip,
          userAgent: params.userAgent ?? null,
          startedAt: new Date(session.startedAt),
        },
      })
      .catch((error) => this.logger.warn(`Ecriture du log impossible: ${error.message}`));

    return { session, feedKey: feed.key };
  }

  async end(session: SessionRecord, reason: StreamEndReason): Promise<void> {
    // Detach the client from the shared feed first: when it was the last
    // one, the hub closes the feed and frees the upstream connection slot.
    this.hub.detach(session.id);
    await this.registry.unregisterSession(session);

    const log = await this.prisma.streamLog.findFirst({
      where: { ticketId: session.ticketId, clientIp: session.clientIp, startedAt: new Date(session.startedAt) },
      orderBy: { startedAt: 'desc' },
    });

    if (log) {
      await this.prisma.streamLog
        .update({
          where: { id: log.id },
          data: {
            endedAt: new Date(),
            durationSec: Math.round((Date.now() - session.startedAt) / 1000),
            bytes: BigInt(session.bytes),
            endReason: reason,
          },
        })
        .catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  /**
   * Enforces `ticket.maxConnections`.
   * REJECT: the new stream is refused with an explicit message.
   * EVICT_OLDEST: the oldest session of the ticket is closed first.
   */
  private async enforceTicketLimit(ticket: Ticket): Promise<void> {
    const sessions = await this.registry.listTicketSessions(ticket.id);
    const decision = evaluateTicketLimit(sessions.length, ticket.maxConnections, ticket.overflowPolicy);

    if (decision.action === 'ALLOW') {
      await this.registry.reserveTicketSlot(ticket.id, ticket.maxConnections);
      return;
    }

    if (decision.action === 'EVICT_OLDEST') {
      const oldest = sessions[0];
      this.logger.warn(
        `Limite du ticket ${ticket.username} atteinte (${ticket.maxConnections}): fermeture de la session la plus ancienne`,
      );
      await this.evictSession(oldest);
      const reserved = await this.registry.reserveTicketSlot(ticket.id, ticket.maxConnections);
      if (reserved) return;
      throw new ServiceUnavailableException(
        'Impossible de liberer une connexion, reessayez dans un instant.',
      );
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: decision.reason,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Enforces the upstream account limit.
   * The limit is never exceeded: either the request is refused or the
   * oldest upstream connection is closed first.
   */
  private async enforceUpstreamLimit(
    providerId: string,
    maxConnections: number,
    feedKey: string,
    policy: OverflowPolicy,
  ): Promise<void> {
    // The stream is already being consumed: no new upstream connection needed.
    if (this.hub.hasFeed(feedKey)) return;
    const existing = await this.registry.listProviderFeeds(providerId);
    if (sharesUpstreamFeed(feedKey, existing)) return;

    const decision = evaluateUpstreamLimit(existing.length, maxConnections, policy);

    if (decision.action === 'ALLOW') {
      const reserved = await this.registry.reserveProviderSlot(providerId, maxConnections);
      if (reserved) return;
      // Atomic reservation refused (counter drifted): re-evaluate.
      const refreshed = await this.registry.listProviderFeeds(providerId);
      const retryDecision = evaluateUpstreamLimit(refreshed.length, maxConnections, policy);
      if (retryDecision.action === 'ALLOW') return;
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: retryDecision.reason,
      });
    }

    if (decision.action === 'EVICT_OLDEST') {
      const oldest = existing[0];
      if (oldest) {
        this.logger.warn(
          `Limite upstream atteinte (${maxConnections}): fermeture du flux le plus ancien ${oldest.feedKey}`,
        );
        await this.hub.requestKill(oldest.feedKey);
        await this.registry.unregisterFeed(oldest);

        // Give the other instance a moment to release its slot.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const retry = await this.registry.reserveProviderSlot(providerId, maxConnections);
        if (retry) return;
      }
    }

    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: decision.reason,
    });
  }

  /** Closes the client session (locally or on the instance that owns it). */
  private async evictSession(session: SessionRecord): Promise<void> {
    await this.hub.requestEvictClient(session.id);
    await this.registry.unregisterSession(session);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async resolveUpstreamUrl(params: StartStreamParams): Promise<string> {
    const adapter = await this.providers.adapter(params.ticket.providerId);

    switch (params.streamKind) {
      case 'live': {
        const channel = await this.prisma.channel.findFirst({
          where: { providerId: params.ticket.providerId, externalId: params.streamId },
        });
        if (!channel) throw new NotFoundException('Chaine introuvable');
        // A stored direct URL (M3U source) takes precedence over the
        // provider-specific URL builder.
        if (channel.streamUrl) return channel.streamUrl;
        return adapter.resolveStreamUrl(StreamKind.LIVE, channel.externalId);
      }
      case 'vod': {
        const movie = await this.prisma.movie.findFirst({
          where: { providerId: params.ticket.providerId, externalId: params.streamId },
        });
        if (!movie) throw new NotFoundException('Film introuvable');
        if (movie.streamUrl) return movie.streamUrl;
        return adapter.resolveStreamUrl(
          StreamKind.VOD,
          movie.externalId,
          movie.containerExtension ?? 'mp4',
        );
      }
      case 'episode': {
        const episode = await this.prisma.seriesEpisode.findFirst({
          where: { externalId: params.streamId, series: { providerId: params.ticket.providerId } },
        });
        if (!episode) throw new NotFoundException('Episode introuvable');
        if (episode.streamUrl) return episode.streamUrl;
        return adapter.resolveStreamUrl(
          StreamKind.EPISODE,
          episode.externalId,
          episode.containerExtension ?? 'mp4',
        );
      }
      default:
        throw new ForbiddenException('Type de flux non autorise');
    }
  }

  private async resolveDisplayName(params: StartStreamParams): Promise<string | undefined> {
    try {
      if (params.streamKind === 'live') {
        const channel = await this.prisma.channel.findFirst({
          where: { providerId: params.ticket.providerId, externalId: params.streamId },
          select: { name: true },
        });
        return channel?.name;
      }
      if (params.streamKind === 'vod') {
        const movie = await this.prisma.movie.findFirst({
          where: { providerId: params.ticket.providerId, externalId: params.streamId },
          select: { name: true },
        });
        return movie?.name;
      }
    } catch {
      /* display name is optional */
    }
    return undefined;
  }
}
