import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { AppConfigService } from '../../common/config/app-config.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TicketsService } from '../tickets/tickets.service';
import { ProvidersService } from '../providers/providers.service';
import { ContentService } from '../content/content.service';
import { ConnectionRegistryService } from '../connections/connection-registry.service';
import { StreamHubService } from '../streaming/stream-hub.service';

/**
 * Background jobs.
 *
 * Cron expressions come from the environment so the operator can tune them
 * without rebuilding the image.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly jobs: CronJob[] = [];
  private heartbeatTimer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly providers: ProvidersService,
    private readonly content: ContentService,
    private readonly connections: ConnectionRegistryService,
    private readonly hub: StreamHubService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    const cron = this.appConfig.cron;

    this.addJob('ticket-expiry', cron.ticketExpiry, () => this.runTicketsExpiry());
    this.addJob('content-sync', cron.contentSync, () => this.runContentSync());
    this.addJob('epg-sync', cron.epgSync, () => this.runEpgSync());
    this.addJob('upstream-max-connections', '*/7 * * * *', () =>
      this.runRefreshMaxConnections(),
    );

    // Heartbeat: keeps the Redis session registry fresh and updates the
    // denormalised counters displayed by the dashboard.
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, 15_000);

    this.logger.log(
      `Planificateur actif (expiration=${cron.ticketExpiry}, catalogue=${cron.contentSync}, epg=${cron.epgSync})`,
    );
  }

  onModuleDestroy(): void {
    for (const job of this.jobs) job.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private addJob(name: string, expression: string, handler: () => Promise<void>): void {
    try {
      const job = new CronJob(expression, () => {
        if (this.running.has(name)) {
          this.logger.warn(`Tache ${name} encore en cours, execution ignoree`);
          return;
        }
        this.running.add(name);
        handler()
          .catch((error) => this.logger.error(`Tache ${name} en echec: ${error.message}`))
          .finally(() => this.running.delete(name));
      });
      job.start();
      this.jobs.push(job);
    } catch (error) {
      this.logger.error(`Impossible de planifier ${name} (${expression}): ${(error as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------

  /** Disables the tickets whose validity date is over. */
  async runTicketsExpiry(): Promise<void> {
    const count = await this.tickets.expireDueTickets();
    if (count > 0) this.logger.log(`Expiration: ${count} ticket(s) desactive(s)`);
  }

  /** Refreshes the catalogue of every enabled provider. */
  async runContentSync(): Promise<void> {
    const providers = await this.providers.list();
    for (const provider of providers) {
      if (!provider.isEnabled) continue;
      try {
        await this.content.syncProvider(provider.id);
      } catch (error) {
        this.logger.error(
          `Synchronisation du provider ${provider.name} impossible: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Refreshes the EPG of every enabled provider. */
  async runEpgSync(): Promise<void> {
    const providers = await this.providers.list();
    for (const provider of providers) {
      if (!provider.isEnabled) continue;
      try {
        await this.content.syncProvider(provider.id, 'EPG' as never);
      } catch (error) {
        this.logger.warn(
          `Synchronisation EPG du provider ${provider.name} impossible: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Re-reads `max_connections` from the upstream panel. */
  async runRefreshMaxConnections(): Promise<void> {
    const providers = await this.providers.list();
    for (const provider of providers) {
      if (!provider.isEnabled || provider.kind !== 'XTREAM') continue;
      await this.providers.refreshMaxConnections(provider.id);
    }
  }

  /**
   * Heartbeat:
   *  - refreshes the session records so they do not expire while playing,
   *  - updates the denormalised upstream counters,
   *  - reconciles the atomic counters after a crash.
   */
  async runHeartbeat(): Promise<void> {
    try {
      const sessions = await this.connections.listAllSessions();
      for (const session of sessions) {
        session.lastBeat = Date.now();
        await this.connections.updateSessionBytes(session);
      }

      const providers = await this.prisma.upstreamProvider.findMany({
        select: { id: true, name: true },
      });

      for (const provider of providers) {
        const feeds = await this.connections.listProviderFeeds(provider.id);
        await this.prisma.upstreamProvider.update({
          where: { id: provider.id },
          data: { activeConnections: feeds.length },
        });
      }

      await this.connections.reconcileCounters(providers.map((provider) => provider.id));
    } catch (error) {
      this.logger.warn(`Heartbeat en erreur: ${(error as Error).message}`);
    }
  }
}
