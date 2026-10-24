import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { request as httpRequest, Agent as HttpAgent, ClientRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { RedisService } from '../../common/redis/redis.service';
import { AppConfigService } from '../../common/config/app-config.service';
import {
  ConnectionRegistryService,
  FeedRecord,
  SessionRecord,
  StreamKindLabel,
} from '../connections/connection-registry.service';

export interface FeedClient {
  id: string;
  session: SessionRecord;
  res: Response;
  attachedAt: number;
  headersSent: boolean;
}

export interface Feed {
  key: string;
  providerId: string;
  providerName: string;
  streamId: string;
  streamKind: StreamKindLabel;
  upstreamUrl: string;
  epoch: string;
  isOwner: boolean;
  source: PassThrough;
  clients: Map<string, FeedClient>;
  bytes: number;
  startedAt: number;
  lastDataAt: number;
  upstreamRequest?: ClientRequest;
  relaySubscription?: ReturnType<RedisService['pubsub']['duplicate']>;
  ownershipTimer?: NodeJS.Timeout;
  relayTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  relayBuffer: Buffer[];
  relayBytes: number;
  slotReserved: boolean;
  closed: boolean;
}

export interface AttachParams {
  providerId: string;
  providerName: string;
  streamId: string;
  streamKind: StreamKindLabel;
  upstreamUrl: string;
  client: FeedClient;
}

const OWNER_TTL_MS = 15_000;
const OWNER_RENEW_MS = 5_000;
const RELAY_FLUSH_MS = 120;
const MAX_RELAY_BUFFER = 64 * 1024;
const MAX_CLIENT_BUFFER = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONTROL_CHANNEL = 'feed:control';

/**
 * Streaming multiplexer.
 *
 * One upstream connection per (provider, stream) is shared by every client
 * watching that stream: this is what keeps the upstream account within its
 * `max_connections` while serving hundreds of devices.
 *
 * Cross-instance fan-out is handled through a Redis relay channel: the
 * instance owning the upstream connection publishes the bytes, the other
 * instances replay them to their own clients.
 */
@Injectable()
export class StreamHubService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamHubService.name);
  private readonly feeds = new Map<string, Feed>();
  private readonly httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 256 });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });
  private maintenanceTimer?: NodeJS.Timeout;
  private controlSubscription?: ReturnType<RedisService['pubsub']['duplicate']>;

  constructor(
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
    private readonly registry: ConnectionRegistryService,
  ) {}

  onModuleDestroy(): void {
    this.shutdown();
  }

  /**
   * Subscribes to the cluster control channel so that any instance can ask
   * another one to close a feed or evict a client.
   */
  private ensureControlChannel(): void {
    if (this.controlSubscription) return;
    const subscriber = this.redis.pubsub.duplicate();
    this.controlSubscription = subscriber;

    void subscriber.subscribe(CONTROL_CHANNEL).catch((error) => {
      this.logger.warn(`Souscription au canal de controle impossible: ${(error as Error).message}`);
    });

    subscriber.on('message', (_channel, message) => {
      let payload: { action?: string; feedKey?: string; sessionId?: string };
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      if (payload.action === 'kill-feed' && payload.feedKey) {
        const feed = this.feeds.get(payload.feedKey);
        if (feed) this.destroyFeed(feed, 'UPSTREAM_LIMIT');
        return;
      }

      if (payload.action === 'evict-client' && payload.sessionId) {
        this.evictClient(payload.sessionId);
      }
    });

    subscriber.on('error', (error) =>
      this.logger.warn(`Canal de controle en erreur: ${error.message}`),
    );
  }

  /** Asks the cluster to close an upstream feed. */
  async requestKill(feedKey: string): Promise<void> {
    this.ensureControlChannel();
    try {
      await this.redis.pubsub.publish(
        CONTROL_CHANNEL,
        JSON.stringify({ action: 'kill-feed', feedKey }),
      );
    } catch (error) {
      this.logger.warn(`Demande de fermeture impossible: ${(error as Error).message}`);
    }
  }

  /** Asks the cluster to evict a client session. */
  async requestEvictClient(sessionId: string): Promise<void> {
    this.ensureControlChannel();
    try {
      await this.redis.pubsub.publish(
        CONTROL_CHANNEL,
        JSON.stringify({ action: 'evict-client', sessionId }),
      );
    } catch (error) {
      this.logger.warn(`Demande d'eviction impossible: ${(error as Error).message}`);
    }
  }

  /** Closes a single client connection (used for session eviction). */
  evictClient(sessionId: string): boolean {
    for (const feed of this.feeds.values()) {
      for (const client of feed.clients.values()) {
        if (client.session.id !== sessionId) continue;
        try {
          client.res.destroy();
        } catch {
          /* ignore */
        }
        feed.clients.delete(client.id);
        this.logger.log(`Session ${sessionId} evincee du flux ${feed.key}`);
        if (feed.clients.size === 0) this.destroyFeed(feed, 'TICKET_LIMIT');
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getFeeds(): Feed[] {
    return [...this.feeds.values()];
  }

  getFeed(feedKey: string): Feed | undefined {
    return this.feeds.get(feedKey);
  }

  getStats() {
    let clients = 0;
    let bytes = 0;
    for (const feed of this.feeds.values()) {
      clients += feed.clients.size;
      bytes += feed.bytes;
    }
    return { feeds: this.feeds.size, clients, bytes };
  }

  /**
   * Attaches a client to a stream, creating the upstream connection only if
   * nobody else is already consuming that stream.
   */
  async attach(params: AttachParams): Promise<Feed> {
    const feedKey = this.feedKey(params.providerId, params.streamKind, params.streamId);

    let feed = this.feeds.get(feedKey);
    if (!feed || feed.closed) {
      feed = await this.createFeed(feedKey, params);
    }

    if (feed.clients.size >= this.appConfig.stream.maxClientsPerFeed) {
      throw new Error('Flux surcharge: trop de clients sur cette chaine.');
    }

    feed.clients.set(params.client.id, params.client);
    this.logger.debug(
      `Client ${params.client.id} attache a ${feedKey} (${feed.clients.size} clients, ${feed.isOwner ? 'owner' : 'relay'})`,
    );

    return feed;
  }

  detach(clientId: string): void {
    for (const feed of this.feeds.values()) {
      const client = feed.clients.get(clientId);
      if (!client) continue;
      feed.clients.delete(clientId);
      this.logger.debug(`Client ${clientId} detache de ${feed.key}`);

      if (feed.clients.size === 0) {
        this.destroyFeed(feed, 'CLIENT_DISCONNECT');
      }
    }
  }

  /**
   * Closes a feed and notifies its clients.
   * Used when the upstream limit forces the oldest stream to be dropped.
   */
  destroyFeed(feed: Feed, reason: string): void {
    if (feed.closed) return;
    feed.closed = true;

    for (const client of feed.clients.values()) {
      try {
        if (!client.headersSent) {
          client.res.status(503).json({
            statusCode: 503,
            error: 'Service Unavailable',
            message:
              reason === 'UPSTREAM_LIMIT'
                ? 'La connexion upstream a ete reaffectee a un autre appareil. Reessayez dans un instant.'
                : 'Flux interrompu.',
          });
        } else {
          client.res.end();
        }
      } catch {
        /* client already gone */
      }
    }
    feed.clients.clear();

    try {
      feed.upstreamRequest?.destroy();
    } catch {
      /* ignore */
    }
    try {
      feed.source.destroy();
    } catch {
      /* ignore */
    }
    if (feed.relaySubscription) {
      feed.relaySubscription.unsubscribe().catch(() => undefined);
    }
    if (feed.ownershipTimer) clearInterval(feed.ownershipTimer);
    if (feed.relayTimer) clearInterval(feed.relayTimer);
    if (feed.heartbeatTimer) clearInterval(feed.heartbeatTimer);

    this.feeds.delete(feed.key);
    this.logger.log(`Flux ${feed.key} ferme (${reason}, ${feed.bytes} octets)`);

    // The feed no longer consumes an upstream connection: free the slot so
    // the next client is not rejected with a 503. Only the instance that
    // actually held the upstream connection manages the registry entry.
    if (feed.isOwner) {
      const record = this.toFeedRecord(feed);
      void this.registry
        .unregisterFeed(record)
        .then(() => this.registry.releaseProviderSlot(feed.providerId));
    }
  }

  shutdown(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.controlSubscription) {
      void this.controlSubscription.unsubscribe().catch(() => undefined);
      this.controlSubscription = undefined;
    }
    for (const feed of [...this.feeds.values()]) {
      this.destroyFeed(feed, 'SERVER_SHUTDOWN');
    }
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  feedKey(providerId: string, streamKind: string, streamId: string): string {
    return `${providerId}:${streamKind}:${streamId}`;
  }

  /**
   * Tells whether this instance already holds the feed.
   * Used to avoid reserving a second upstream connection while the feed is
   * being created but is not registered in Redis yet.
   */
  hasFeed(feedKey: string): boolean {
    const feed = this.feeds.get(feedKey);
    return Boolean(feed && !feed.closed);
  }

  private async createFeed(feedKey: string, params: AttachParams): Promise<Feed> {
    const feed: Feed = {
      key: feedKey,
      providerId: params.providerId,
      providerName: params.providerName,
      streamId: params.streamId,
      streamKind: params.streamKind,
      upstreamUrl: params.upstreamUrl,
      epoch: randomUUID(),
      isOwner: false,
      source: new PassThrough({ highWaterMark: 1024 * 1024 }),
      clients: new Map(),
      bytes: 0,
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      relayBuffer: [],
      relayBytes: 0,
      slotReserved: false,
      closed: false,
    };

    feed.source.on('data', (chunk: Buffer) => this.onFeedData(feed, chunk));

    this.feeds.set(feedKey, feed);

    const isOwner = await this.tryAcquireOwnership(feed);
    if (isOwner) {
      await this.openUpstream(feed);
    } else {
      await this.subscribeRelay(feed);
    }

    // Keep the registry entry alive: without a heartbeat the feed would be
    // dropped as stale by the TTL while the upstream connection is still
    // running, and the next client would open a second upstream connection.
    feed.heartbeatTimer = setInterval(
      () => this.heartbeat(feed),
      Math.max(5_000, Math.floor(OWNER_RENEW_MS / 2)),
    );

    this.startMaintenance();
    return feed;
  }

  /** Refreshes the feed record in the registry. */
  private heartbeat(feed: Feed): void {
    if (feed.closed) return;
    void this.registry.updateFeed(this.toFeedRecord(feed)).catch((error) => {
      this.logger.warn(`Heartbeat du flux impossible: ${(error as Error).message}`);
    });
  }

  /**
   * Tries to become the owner of the upstream feed.
   * Only one instance in the cluster may hold the upstream connection.
   */
  private async tryAcquireOwnership(feed: Feed): Promise<boolean> {
    try {
      const result = await this.redis.commands.set(
        `feed:owner:${feed.key}`,
        feed.epoch,
        'PX',
        OWNER_TTL_MS,
        'NX',
      );
      if (result === 'OK') {
        feed.isOwner = true;
        feed.ownershipTimer = setInterval(() => this.renewOwnership(feed), OWNER_RENEW_MS);
        this.logger.log(`Flux ${feed.key}: cette instance est proprietaire de la connexion upstream`);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(`Impossible de prendre la propriete du flux: ${(error as Error).message}`);
      return false;
    }
  }

  private renewOwnership(feed: Feed): void {
    if (feed.closed || !feed.isOwner) return;
    void this.redis.commands
      .set(`feed:owner:${feed.key}`, feed.epoch, 'PX', OWNER_TTL_MS, 'XX')
      .catch((error) =>
        this.logger.warn(`Renouvellement de propriete impossible: ${(error as Error).message}`),
      );
  }

  private async openUpstream(feed: Feed): Promise<void> {
    await this.fetchUpstream(feed, feed.upstreamUrl, 0);
  }

  /**
   * Opens the HTTP connection to the upstream and pipes it into the feed.
   * Redirects are followed manually (Xtream servers often redirect).
   */
  private fetchUpstream(feed: Feed, url: string, redirectCount: number): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.failFeed(feed, `URL upstream invalide: ${url}`);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? httpsRequest : httpRequest;

    const req = client(
      parsed,
      {
        method: 'GET',
        agent: isHttps ? this.httpsAgent : this.httpAgent,
        headers: {
          'User-Agent': 'IPTV-Home-Gateway/1.0',
          Accept: '*/*',
          Connection: 'keep-alive',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            this.failFeed(feed, 'Trop de redirections upstream');
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          this.fetchUpstream(feed, next, redirectCount + 1);
          return;
        }

        if (status !== 200) {
          res.resume();
          this.failFeed(feed, `Le serveur upstream a repondu HTTP ${status}`);
          return;
        }

        res.on('data', (chunk: Buffer) => {
          feed.bytes += chunk.length;
          feed.lastDataAt = Date.now();
          if (feed.source.write(chunk)) return;
          // The local buffer is saturated: drop the slowest consumers.
          this.evictSlowClients(feed);
        });

        res.on('error', (error) => this.failFeed(feed, `Erreur reseau upstream: ${error.message}`));
        res.on('end', () => {
          if (!feed.closed) {
            this.failFeed(feed, 'Le flux upstream s\'est termine');
          }
        });
      },
    );

    feed.upstreamRequest = req;

    req.on('error', (error) => {
      if (!feed.closed) {
        this.failFeed(feed, `Connexion upstream impossible: ${error.message}`);
      }
    });

    req.setTimeout(30_000, () => {
      // No data for 30s on the upstream socket: keep the connection but flag it.
      this.logger.warn(`Socket upstream silencieux pour ${feed.key}`);
    });

    req.end();
  }

  /** Fan-out to every attached client, with per-client back-pressure. */
  private onFeedData(feed: Feed, chunk: Buffer): void {
    if (feed.isOwner) {
      this.publishRelay(feed, chunk);
    }
    this.writeToClients(feed, chunk);
  }

  private writeToClients(feed: Feed, chunk: Buffer): void {
    for (const client of feed.clients.values()) {
      try {
        if (!client.headersSent) {
          client.res.status(200);
          client.res.setHeader('Content-Type', 'video/mp2t');
          client.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          client.res.setHeader('Pragma', 'no-cache');
          client.res.setHeader('Connection', 'close');
          client.headersSent = true;
        }

        client.res.write(chunk);
        client.session.bytes += chunk.length;

        // A `write()` returning false only means the socket buffer is full:
        // that is normal back-pressure, not a slow client. The client is only
        // dropped when the pending buffer exceeds the hard cap, which means it
        // really cannot keep up (and would blow the memory of the instance).
        if (client.res.writableLength > MAX_CLIENT_BUFFER) {
          this.logger.warn(
            `Client lent retire du flux ${feed.key} (${client.res.writableLength} octets en buffer)`,
          );
          try {
            client.res.destroy();
          } catch {
            /* ignore */
          }
          feed.clients.delete(client.id);
        }
      } catch (error) {
        this.logger.warn(`Ecriture client impossible: ${(error as Error).message}`);
        feed.clients.delete(client.id);
      }
    }
  }

  private evictSlowClients(feed: Feed): void {
    for (const client of feed.clients.values()) {
      if (client.res.writableLength > MAX_CLIENT_BUFFER) {
        try {
          client.res.destroy();
        } catch {
          /* ignore */
        }
        feed.clients.delete(client.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cross-instance relay
  // -------------------------------------------------------------------------

  private publishRelay(feed: Feed, chunk: Buffer): void {
    feed.relayBuffer.push(chunk);
    feed.relayBytes += chunk.length;

    if (feed.relayBytes >= MAX_RELAY_BUFFER) {
      this.flushRelay(feed);
      return;
    }
    if (!feed.relayTimer) {
      feed.relayTimer = setTimeout(() => this.flushRelay(feed), RELAY_FLUSH_MS);
    }
  }

  private flushRelay(feed: Feed): void {
    if (feed.relayTimer) {
      clearTimeout(feed.relayTimer);
      feed.relayTimer = undefined;
    }
    if (!feed.relayBuffer.length) return;

    const payload = Buffer.concat(feed.relayBuffer);
    feed.relayBuffer = [];
    feed.relayBytes = 0;

    void this.redis.pubsub
      .publish(`relay:${feed.key}`, payload)
      .catch((error) =>
        this.logger.warn(`Publication relay impossible: ${(error as Error).message}`),
      );
  }

  /** Subscribes to the relay channel of a feed owned by another instance. */
  private async subscribeRelay(feed: Feed): Promise<void> {
    const channel = `relay:${feed.key}`;
    const subscriber = this.redis.pubsub.duplicate();

    try {
      await subscriber.subscribe(channel);
      feed.relaySubscription = subscriber;

      subscriber.on('message', (incoming, payload) => {
        if (incoming !== channel || feed.closed) return;
        const chunk = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        feed.lastDataAt = Date.now();
        feed.bytes += chunk.length;
        feed.source.write(chunk);
      });

      subscriber.on('error', (error) =>
        this.logger.warn(`Relay ${feed.key} en erreur: ${error.message}`),
      );

      this.logger.log(`Flux ${feed.key}: relais vers une autre instance`);

      // If no byte arrives, the owner is probably dead: try to take over.
      setTimeout(() => {
        if (feed.closed || feed.lastDataAt > Date.now() - 1000) return;
        void this.takeOver(feed);
      }, 8_000);
    } catch (error) {
      this.logger.error(`Souscription relay impossible: ${(error as Error).message}`);
      // Fall back to a local upstream connection: degraded but functional.
      await this.openUpstream(feed);
    }
  }

  /** Attempts to promote this instance to owner after the initial owner failed. */
  private async takeOver(feed: Feed): Promise<void> {
    if (feed.closed || feed.isOwner) return;

    const acquired = await this.tryAcquireOwnership(feed);
    if (!acquired) return;

    this.logger.warn(`Flux ${feed.key}: reprise de la connexion upstream`);
    try {
      if (feed.relaySubscription) {
        await feed.relaySubscription.unsubscribe();
        feed.relaySubscription = undefined;
      }
    } catch {
      /* ignore */
    }
    await this.openUpstream(feed);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  private startMaintenance(): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => this.maintenance(), 10_000);
  }

  private maintenance(): void {
    const now = Date.now();
    const idleTimeout = this.appConfig.stream.idleTimeoutSec * 1000;

    for (const feed of [...this.feeds.values()]) {
      if (feed.clients.size === 0) {
        this.destroyFeed(feed, 'CLIENT_DISCONNECT');
        continue;
      }
      if (now - feed.lastDataAt > idleTimeout) {
        this.logger.warn(`Flux ${feed.key}: inactivite prolongee, fermeture`);
        this.destroyFeed(feed, 'IDLE_TIMEOUT');
      }
    }
  }

  private failFeed(feed: Feed, reason: string): void {
    if (feed.closed) return;
    this.logger.warn(`Flux ${feed.key} en erreur: ${reason}`);
    this.destroyFeed(feed, 'UPSTREAM_ERROR');
  }

  /** Converts an upstream feed into its Redis registry representation. */
  toFeedRecord(feed: Feed): FeedRecord {
    return {
      feedKey: feed.key,
      providerId: feed.providerId,
      streamId: feed.streamId,
      streamKind: feed.streamKind,
      upstreamUrl: feed.upstreamUrl,
      startedAt: feed.startedAt,
      lastBeat: Date.now(),
      bytes: feed.bytes,
      clients: feed.clients.size,
    };
  }
}
