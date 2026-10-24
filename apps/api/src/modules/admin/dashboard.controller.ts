import { Controller, Get, UseGuards } from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConnectionRegistryService } from '../connections/connection-registry.service';
import { StreamHubService } from '../streaming/stream-hub.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { TicketsService } from '../tickets/tickets.service';
import { ProvidersService } from '../providers/providers.service';

interface DashboardPayload {
  activeConnections: Array<{
    sessionId: string;
    ticketId: string;
    ticketLabel: string;
    username: string;
    providerName: string;
    channelName: string | null;
    streamId: string;
    streamKind: string;
    clientIp: string;
    startedAt: string;
    durationSec: number;
    bytes: number;
  }>;
  providers: Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    activeConnections: number;
    maxConnections: number;
    usagePercent: number;
    overflowPolicy: string;
  }>;
  expiringTickets: Array<{
    id: string;
    label: string;
    username: string;
    expiresAt: string;
    remainingMs: number;
    maxConnections: number;
  }>;
  stats: {
    totalTickets: number;
    activeTickets: number;
    suspendedTickets: number;
    expiredTickets: number;
    totalSessionsToday: number;
    activeSessions: number;
    uniqueClients: number;
    hubFeeds: number;
    hubClients: number;
    totalBytesStreamed: number;
  };
}

/**
 * Live dashboard of the gateway.
 */
@Controller('api/admin/dashboard')
@UseGuards(AdminAuthGuard)
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistryService,
    private readonly hub: StreamHubService,
    private readonly tickets: TicketsService,
    private readonly providers: ProvidersService,
  ) {}

  @Get()
  async dashboard(): Promise<DashboardPayload> {
    const [sessions, providers, expiring, counts, sessionsToday, hubStats] = await Promise.all([
      this.registry.listAllSessions(),
      this.providers.list(),
      this.tickets.expiringSoon(72),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.streamLog.count({
        where: { startedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      Promise.resolve(this.hub.getStats()),
    ]);

    const byStatus = new Map(counts.map((row) => [row.status, row._count._all]));
    const uniqueClients = new Set(sessions.map((session) => session.clientIp)).size;

    return {
      activeConnections: sessions.map((session) => ({
        sessionId: session.id,
        ticketId: session.ticketId,
        ticketLabel: session.ticketLabel,
        username: session.username,
        providerName: session.providerName,
        channelName: session.channelName ?? null,
        streamId: session.streamId,
        streamKind: session.streamKind,
        clientIp: session.clientIp,
        startedAt: new Date(session.startedAt).toISOString(),
        durationSec: Math.round((Date.now() - session.startedAt) / 1000),
        bytes: session.bytes,
      })),
      providers: providers.map((provider) => {
        const active = provider.activeConnections;
        return {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          status: provider.status,
          activeConnections: active,
          maxConnections: provider.maxConnections,
          usagePercent:
            provider.maxConnections > 0
              ? Math.round((active / provider.maxConnections) * 100)
              : 0,
          overflowPolicy: provider.overflowPolicy,
        };
      }),
      expiringTickets: expiring.map((ticket) => ({
        id: ticket.id,
        label: ticket.label,
        username: ticket.username,
        expiresAt: ticket.expiresAt.toISOString(),
        remainingMs: ticket.remainingMs,
        maxConnections: ticket.maxConnections,
      })),
      stats: {
        totalTickets: [...byStatus.values()].reduce((sum, value) => sum + value, 0),
        activeTickets: byStatus.get(TicketStatus.ACTIVE) ?? 0,
        suspendedTickets: byStatus.get(TicketStatus.SUSPENDED) ?? 0,
        expiredTickets: byStatus.get(TicketStatus.EXPIRED) ?? 0,
        totalSessionsToday: sessionsToday,
        activeSessions: sessions.length,
        uniqueClients,
        hubFeeds: hubStats.feeds,
        hubClients: hubStats.clients,
        totalBytesStreamed: hubStats.bytes,
      },
    };
  }

  /** Detail of the connections currently active on a given provider. */
  @Get('connections')
  async connections(): Promise<DashboardPayload['activeConnections']> {
    const sessions = await this.registry.listAllSessions();
    return sessions.map((session) => ({
      sessionId: session.id,
      ticketId: session.ticketId,
      ticketLabel: session.ticketLabel,
      username: session.username,
      providerName: session.providerName,
      channelName: session.channelName ?? null,
      streamId: session.streamId,
      streamKind: session.streamKind,
      clientIp: session.clientIp,
      startedAt: new Date(session.startedAt).toISOString(),
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      bytes: session.bytes,
    }));
  }
}
