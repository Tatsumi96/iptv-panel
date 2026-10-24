import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

export type StreamKindLabel = 'live' | 'vod' | 'episode';

export interface SessionRecord {
  id: string;
  ticketId: string;
  ticketLabel: string;
  username: string;
  providerId: string;
  providerName: string;
  streamId: string;
  streamKind: StreamKindLabel;
  channelName?: string;
  clientIp: string;
  userAgent?: string;
  startedAt: number;
  lastBeat: number;
  bytes: number;
  /** Key of the shared upstream feed this session is attached to. */
  feedKey?: string;
}

export interface FeedRecord {
  feedKey: string;
  providerId: string;
  streamId: string;
  streamKind: StreamKindLabel;
  upstreamUrl: string;
  startedAt: number;
  lastBeat: number;
  bytes: number;
  clients: number;
}

/** Sessions are considered dead when no heartbeat arrived for this long. */
const SESSION_TTL_MS = 75_000;
const FEED_TTL_MS = 75_000;

/**
 * Reserves an upstream connection slot.
 *
 * The hash of live feeds is the authoritative source: the counter is only a
 * cache and is recomputed from the hash on every reservation. This makes the
 * accounting self-healing: a crashed instance leaves a stale record that is
 * dropped by the TTL, and the counter is re-aligned on the next reservation.
 *
 * KEYS[1] = hash of live feeds for the provider
 * KEYS[2] = counter of used upstream slots
 * ARGV[1] = maximum number of simultaneous upstream connections
 */
const RESERVE_SLOT_SCRIPT = `
local live = redis.call('HLEN', KEYS[1])
local maximum = tonumber(ARGV[1])
if live >= maximum then
  redis.call('SET', KEYS[2], live)
  return 0
end
redis.call('SET', KEYS[2], live + 1)
return 1
`;

/**
 * Authoritative registry of active connections, stored in Redis.
 *
 * Redis (not the local memory) is the source of truth so that:
 *  - the dashboard can list sessions started by any instance,
 *  - the upstream connection limit is enforced across the whole cluster,
 *  - a crash leaves no orphan slot (records expire with their TTL).
 */
@Injectable()
export class ConnectionRegistryService {
  private readonly logger = new Logger(ConnectionRegistryService.name);

  constructor(private readonly redis: RedisService) {}

  private sessionKey(ticketId: string): string {
    return `sess:t:${ticketId}`;
  }

  private providerSessionKey(providerId: string): string {
    return `sess:p:${providerId}`;
  }

  private allSessionsKey(): string {
    return 'sess:all';
  }

  private providerFeedsKey(providerId: string): string {
    return `feed:p:${providerId}`;
  }

  private feedCounterKey(providerId: string): string {
    return `feed:count:${providerId}`;
  }

  private ticketCounterKey(ticketId: string): string {
    return `sess:count:${ticketId}`;
  }

  // -------------------------------------------------------------------------
  // Client sessions (ticket scope)
  // -------------------------------------------------------------------------

  /**
   * Atomically reserves a client slot for the ticket.
   * Returns false when the ticket already reached its `maxConnections`.
   */
  async reserveTicketSlot(ticketId: string, maxConnections: number): Promise<boolean> {
    try {
      const result = await this.redis.commands.eval(
        RESERVE_SLOT_SCRIPT,
        1,
        this.ticketCounterKey(ticketId),
        String(Math.max(1, maxConnections)),
      );
      return Number(result) === 1;
    } catch (error) {
      this.logger.warn(`Reservation de slot impossible: ${(error as Error).message}`);
      return true; // fail-open, the DB check still protects us
    }
  }

  async releaseTicketSlot(ticketId: string): Promise<void> {
    try {
      await this.redis.commands.decr(this.ticketCounterKey(ticketId));
    } catch {
      /* best effort */
    }
  }

  async registerSession(session: SessionRecord): Promise<void> {
    const payload = JSON.stringify(session);
    const client = this.redis.commands;
    try {
      await client
        .multi()
        .hset(this.sessionKey(session.ticketId), session.id, payload)
        .hset(this.providerSessionKey(session.providerId), session.id, payload)
        .hset(this.allSessionsKey(), session.id, payload)
        .exec();
    } catch (error) {
      this.logger.warn(`Enregistrement de session impossible: ${(error as Error).message}`);
    }
  }

  async unregisterSession(session: SessionRecord): Promise<void> {
    const client = this.redis.commands;
    try {
      await client
        .multi()
        .hdel(this.sessionKey(session.ticketId), session.id)
        .hdel(this.providerSessionKey(session.providerId), session.id)
        .hdel(this.allSessionsKey(), session.id)
        .exec();
      await this.releaseTicketSlot(session.ticketId);
    } catch (error) {
      this.logger.warn(`Desenregistrement de session impossible: ${(error as Error).message}`);
    }
  }

  async updateSessionBytes(session: SessionRecord): Promise<void> {
    session.lastBeat = Date.now();
    const payload = JSON.stringify(session);
    try {
      await this.redis.commands
        .multi()
        .hset(this.sessionKey(session.ticketId), session.id, payload)
        .hset(this.providerSessionKey(session.providerId), session.id, payload)
        .hset(this.allSessionsKey(), session.id, payload)
        .exec();
    } catch {
      /* best effort */
    }
  }

  async listTicketSessions(ticketId: string): Promise<SessionRecord[]> {
    return this.readPruned(this.sessionKey(ticketId));
  }

  async listProviderSessions(providerId: string): Promise<SessionRecord[]> {
    return this.readPruned(this.providerSessionKey(providerId));
  }

  async listAllSessions(): Promise<SessionRecord[]> {
    return this.readPruned(this.allSessionsKey());
  }

  async countTicketSessions(ticketId: string): Promise<number> {
    return (await this.listTicketSessions(ticketId)).length;
  }

  /** Removes expired records from a hash and returns the alive ones. */
  private async readPruned(key: string): Promise<SessionRecord[]> {
    try {
      const raw = await this.redis.commands.hgetall(key);
      const now = Date.now();
      const alive: SessionRecord[] = [];
      const stale: string[] = [];

      for (const [id, value] of Object.entries(raw)) {
        try {
          const record = JSON.parse(value) as SessionRecord;
          if (now - record.lastBeat > SESSION_TTL_MS) {
            stale.push(id);
          } else {
            alive.push(record);
          }
        } catch {
          stale.push(id);
        }
      }

      if (stale.length) {
        await this.redis.commands.hdel(key, ...stale);
      }

      return alive.sort((a, b) => a.startedAt - b.startedAt);
    } catch (error) {
      this.logger.warn(`Lecture du registre impossible: ${(error as Error).message}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Upstream feeds (provider scope)
  // -------------------------------------------------------------------------

  /**
   * Atomically reserves an upstream connection slot for the provider.
   * Returns false when the upstream account limit is reached.
   */
  async reserveProviderSlot(providerId: string, maxConnections: number): Promise<boolean> {
    try {
      const result = await this.redis.commands.eval(
        RESERVE_SLOT_SCRIPT,
        2,
        this.providerFeedsKey(providerId),
        this.feedCounterKey(providerId),
        String(Math.max(1, maxConnections)),
      );
      return Number(result) === 1;
    } catch (error) {
      this.logger.warn(`Reservation de slot upstream impossible: ${(error as Error).message}`);
      return true;
    }
  }

  async releaseProviderSlot(providerId: string): Promise<void> {
    try {
      const remaining = await this.redis.commands.decr(this.feedCounterKey(providerId));
      // The counter is recomputed from the feed hash on the next reservation:
      // clamp it so a double release can never make it negative.
      if (Number(remaining) < 0) {
        await this.redis.commands.set(this.feedCounterKey(providerId), '0');
      }
    } catch {
      /* best effort */
    }
  }

  async registerFeed(feed: FeedRecord): Promise<void> {
    try {
      await this.redis.commands.hset(this.providerFeedsKey(feed.providerId), feed.feedKey, JSON.stringify(feed));
    } catch (error) {
      this.logger.warn(`Enregistrement du flux impossible: ${(error as Error).message}`);
    }
  }

  async updateFeed(feed: FeedRecord): Promise<void> {
    await this.registerFeed(feed);
  }

  /**
   * Removes the feed from the registry.
   * The upstream slot is released separately by the instance that actually
   * held the upstream connection (see `releaseProviderSlot`).
   */
  async unregisterFeed(feed: FeedRecord): Promise<void> {
    try {
      await this.redis.commands.hdel(this.providerFeedsKey(feed.providerId), feed.feedKey);
    } catch (error) {
      this.logger.warn(`Desenregistrement du flux impossible: ${(error as Error).message}`);
    }
  }

  async listProviderFeeds(providerId: string): Promise<FeedRecord[]> {
    try {
      const raw = await this.redis.commands.hgetall(this.providerFeedsKey(providerId));
      const now = Date.now();
      const alive: FeedRecord[] = [];
      const stale: string[] = [];

      for (const [key, value] of Object.entries(raw)) {
        try {
          const record = JSON.parse(value) as FeedRecord;
          if (now - record.lastBeat > FEED_TTL_MS) stale.push(key);
          else alive.push(record);
        } catch {
          stale.push(key);
        }
      }
      if (stale.length) {
        await this.redis.commands.hdel(this.providerFeedsKey(providerId), ...stale);
      }
      return alive.sort((a, b) => a.startedAt - b.startedAt);
    } catch {
      return [];
    }
  }

  async countProviderFeeds(providerId: string): Promise<number> {
    return (await this.listProviderFeeds(providerId)).length;
  }

  /**
   * Reconciles the atomic counters with the real content of the hashes.
   * Called by the heartbeat to fix any drift after a crash.
   */
  async reconcileCounters(providerIds: string[]): Promise<void> {
    for (const providerId of providerIds) {
      try {
        const actual = await this.countProviderFeeds(providerId);
        const counter = Number(
          (await this.redis.commands.get(this.feedCounterKey(providerId))) ?? '0',
        );
        if (counter !== actual) {
          await this.redis.commands.set(this.feedCounterKey(providerId), actual);
          this.logger.warn(
            `Compteur upstream recale pour ${providerId}: ${counter} -> ${actual}`,
          );
        }
      } catch {
        /* best effort */
      }
    }
  }

  /** Background cleanup of orphan hashes left by crashed instances. */
  async purgeStale(): Promise<number> {
    let removed = 0;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.commands.scan(
          cursor,
          'MATCH',
          'sess:*',
          'COUNT',
          200,
        );
        cursor = next;
        for (const key of keys) {
          if (key.endsWith(':count')) continue;
          const raw = await this.redis.commands.hgetall(key);
          const now = Date.now();
          const stale = Object.entries(raw)
            .filter(([, value]) => {
              try {
                const record = JSON.parse(value) as SessionRecord;
                return now - record.lastBeat > SESSION_TTL_MS;
              } catch {
                return true;
              }
            })
            .map(([id]) => id);
          if (stale.length) {
            await this.redis.commands.hdel(key, ...stale);
            removed += stale.length;
          }
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`Nettoyage des sessions expirees impossible: ${(error as Error).message}`);
    }
    return removed;
  }
}
