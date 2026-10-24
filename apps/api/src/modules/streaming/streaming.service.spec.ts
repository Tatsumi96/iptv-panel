import { OverflowPolicy, ProviderKind, TicketStatus } from '@prisma/client';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { StreamingService } from './streaming.service';
import { ConnectionRegistryService, FeedRecord, SessionRecord } from '../connections/connection-registry.service';
import { StreamHubService } from './stream-hub.service';

/**
 * Integration test of the streaming limits with an in-memory registry.
 * Verifies that the upstream account limit is never exceeded and that the
 * fan-out keeps a single upstream connection for a shared stream.
 */
class InMemoryRegistry {
  sessions: SessionRecord[] = [];
  feeds: FeedRecord[] = [];
  ticketCounters = new Map<string, number>();
  providerCounters = new Map<string, number>();
  releasedSlots = 0;

  async listTicketSessions(ticketId: string): Promise<SessionRecord[]> {
    return this.sessions.filter((session) => session.ticketId === ticketId);
  }

  async listProviderFeeds(providerId: string): Promise<FeedRecord[]> {
    return this.feeds.filter((feed) => feed.providerId === providerId);
  }

  async reserveTicketSlot(ticketId: string, maxConnections: number): Promise<boolean> {
    const current = this.ticketCounters.get(ticketId) ?? 0;
    if (current >= maxConnections) return false;
    this.ticketCounters.set(ticketId, current + 1);
    return true;
  }

  async releaseTicketSlot(ticketId: string): Promise<void> {
    this.releasedSlots += 1;
    const current = this.ticketCounters.get(ticketId) ?? 0;
    this.ticketCounters.set(ticketId, Math.max(0, current - 1));
  }

  async reserveProviderSlot(providerId: string, maxConnections: number): Promise<boolean> {
    const current = this.providerCounters.get(providerId) ?? 0;
    if (current >= maxConnections) return false;
    this.providerCounters.set(providerId, current + 1);
    return true;
  }

  async releaseProviderSlot(providerId: string): Promise<void> {
    const current = this.providerCounters.get(providerId) ?? 0;
    this.providerCounters.set(providerId, Math.max(0, current - 1));
  }

  async registerSession(session: SessionRecord): Promise<void> {
    this.sessions.push(session);
  }

  async unregisterSession(session: SessionRecord): Promise<void> {
    this.sessions = this.sessions.filter((item) => item.id !== session.id);
    await this.releaseTicketSlot(session.ticketId);
  }

  async registerFeed(feed: FeedRecord): Promise<void> {
    // Emulate a Redis hash: the feed key is unique.
    this.feeds = this.feeds.filter((item) => item.feedKey !== feed.feedKey);
    this.feeds.push(feed);
  }

  async unregisterFeed(feed: FeedRecord): Promise<void> {
    this.feeds = this.feeds.filter((item) => item.feedKey !== feed.feedKey);
    await this.releaseProviderSlot(feed.providerId);
  }
}

describe('StreamingService', () => {
  const provider = {
    id: 'provider-1',
    name: 'Compte principal',
    kind: ProviderKind.XTREAM,
    maxConnections: 2,
    overflowPolicy: OverflowPolicy.REJECT,
  };

  const ticket = {
    id: 'ticket-1',
    label: 'Salon',
    username: 'salon',
    password: 'secret',
    providerId: 'provider-1',
    startsAt: new Date(Date.now() - 3600_000),
    expiresAt: new Date(Date.now() + 3600_000),
    status: TicketStatus.ACTIVE,
    maxConnections: 2,
    overflowPolicy: OverflowPolicy.REJECT,
    useCategoryFilter: false,
  };

  let registry: InMemoryRegistry;
  let service: StreamingService;
  let hub: { attach: jest.Mock; feedKey: jest.Mock; hasFeed: jest.Mock; requestKill: jest.Mock; requestEvictClient: jest.Mock; toFeedRecord: jest.Mock };
  let prisma: { channel: { findFirst: jest.Mock }; seriesEpisode: { findFirst: jest.Mock }; movie: { findFirst: jest.Mock }; streamLog: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock } };

  beforeEach(() => {
    registry = new InMemoryRegistry();

    hub = {
      attach: jest.fn().mockImplementation(async (params) => ({
        key: `provider-1:${params.streamKind}:${params.streamId}`,
        clients: new Map(),
        bytes: 0,
        startedAt: Date.now(),
        lastDataAt: Date.now(),
        providerId: params.providerId,
        providerName: params.providerName,
        streamId: params.streamId,
        streamKind: params.streamKind,
        upstreamUrl: params.upstreamUrl,
        epoch: 'epoch',
        isOwner: true,
        source: {},
        relayBuffer: [],
        relayBytes: 0,
        slotReserved: false,
        closed: false,
      })),
      feedKey: jest.fn((providerId: string, kind: string, streamId: string) => `${providerId}:${kind}:${streamId}`),
      hasFeed: jest.fn(() => false),
      requestKill: jest.fn(),
      requestEvictClient: jest.fn(),
      toFeedRecord: jest.fn((feed) => ({
        feedKey: feed.key,
        providerId: feed.providerId,
        streamId: feed.streamId,
        streamKind: feed.streamKind,
        upstreamUrl: feed.upstreamUrl,
        startedAt: feed.startedAt,
        lastBeat: Date.now(),
        bytes: feed.bytes,
        clients: feed.clients.size,
      })),
    };

    prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch-1',
          providerId: 'provider-1',
          externalId: '42',
          name: 'France 2',
          streamUrl: null,
          categoryId: null,
          tvgId: 'france2',
          epgChannelId: 'france2',
          streamIcon: null,
          streamType: 'live',
          order: 1,
          timeshift: false,
          tvArchiveDuration: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      seriesEpisode: { findFirst: jest.fn().mockResolvedValue(null) },
      movie: { findFirst: jest.fn().mockResolvedValue(null) },
      streamLog: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const providers = {
      getRaw: jest.fn().mockResolvedValue(provider),
      adapter: jest.fn().mockResolvedValue({
        resolveStreamUrl: jest.fn().mockResolvedValue('http://upstream/live/u/p/42.ts'),
      }),
    };

    service = new StreamingService(
      prisma as never,
      providers as never,
      registry as unknown as ConnectionRegistryService,
      hub as unknown as StreamHubService,
    );
  });

  const start = (streamId = '42', ip = '10.0.0.1', overrides: Record<string, unknown> = {}) =>
    service.start({
      ticket: { ...ticket, ...overrides } as never,
      streamKind: 'live',
      streamId,
      ip,
      userAgent: 'jest',
      res: {} as never,
    });

  it('opens a stream and registers the session', async () => {
    const { session } = await start();

    expect(session.streamId).toBe('42');
    expect(session.channelName).toBe('France 2');
    expect(registry.sessions).toHaveLength(1);
    expect(registry.feeds).toHaveLength(1);
  });

  it('refuses a second device when the ticket allows a single connection', async () => {
    await start();
    registry.sessions.push({
      ...registry.sessions[0],
      id: 'other-session',
    });

    await expect(start('43', '10.0.0.2')).rejects.toBeInstanceOf(HttpException);
  });

  it('never opens more upstream connections than the account allows', async () => {
    // The account allows 2 simultaneous upstream connections, the ticket allows 5.
    await start('42', '10.0.0.1', { maxConnections: 5 });
    await start('43', '10.0.0.2', { maxConnections: 5 });

    expect(registry.feeds).toHaveLength(2);

    await expect(start('44', '10.0.0.3', { maxConnections: 5 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(registry.feeds).toHaveLength(2);
  });

  it('shares a single upstream connection for two devices on the same channel', async () => {
    await start('42', '10.0.0.1');
    await start('42', '10.0.0.2');

    expect(registry.feeds).toHaveLength(1);
    expect(registry.sessions).toHaveLength(2);
    expect(hub.attach).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest upstream feed when the policy allows it', async () => {
    const evictingProvider = { ...provider, overflowPolicy: OverflowPolicy.EVICT_OLDEST };
    (service as never as { providers: unknown }) as never;

    await start('42', '10.0.0.1');
    await start('43', '10.0.0.2');

    registry.feeds[0].startedAt = Date.now() - 60_000;

    const evictingService = new StreamingService(
      prisma as never,
      { getRaw: jest.fn().mockResolvedValue(evictingProvider), adapter: jest.fn().mockResolvedValue({ resolveStreamUrl: jest.fn().mockResolvedValue('http://upstream/x.ts') }) } as never,
      registry as unknown as ConnectionRegistryService,
      hub as unknown as StreamHubService,
    );

    await evictingService.start({
      ticket: { ...ticket, maxConnections: 5 } as never,
      streamKind: 'live',
      streamId: '44',
      ip: '10.0.0.3',
      userAgent: 'jest',
      res: {} as never,
    });

    expect(hub.requestKill).toHaveBeenCalled();
    expect(registry.feeds.length).toBeLessThanOrEqual(2);
  });
});
