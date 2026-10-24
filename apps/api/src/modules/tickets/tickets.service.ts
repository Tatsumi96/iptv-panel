import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OverflowPolicy,
  Prisma,
  Ticket,
  TicketDurationPreset,
  TicketStatus,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AppConfigService } from '../../common/config/app-config.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { computeExpiry, evaluateTicket, renewalDeadline } from './ticket-lifecycle';

const USERNAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';

export interface CreateTicketInput {
  label: string;
  providerId: string;
  username?: string;
  password?: string;
  duration?: TicketDurationPreset;
  /** Custom duration in hours (used when duration = CUSTOM). */
  customDurationHours?: number;
  startsAt?: Date;
  expiresAt?: Date;
  maxConnections?: number;
  overflowPolicy?: OverflowPolicy;
  useCategoryFilter?: boolean;
  categoryIds?: string[];
  notes?: string;
}

export interface UpdateTicketInput {
  label?: string;
  maxConnections?: number;
  overflowPolicy?: OverflowPolicy;
  useCategoryFilter?: boolean;
  categoryIds?: string[];
  notes?: string;
  providerId?: string;
}

export interface TicketView {
  id: string;
  label: string;
  username: string;
  password: string;
  providerId: string;
  providerName: string;
  startsAt: Date;
  expiresAt: Date;
  status: TicketStatus;
  maxConnections: number;
  overflowPolicy: OverflowPolicy;
  useCategoryFilter: boolean;
  categoryIds: string[];
  notes: string | null;
  lastConnectedAt: Date | null;
  lastIp: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Effective status recomputed from the dates (may differ from `status`). */
  effectiveStatus: TicketStatus;
  remainingMs: number;
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(input: CreateTicketInput): Promise<TicketView> {
    const provider = await this.prisma.upstreamProvider.findUnique({
      where: { id: input.providerId },
    });
    if (!provider) throw new NotFoundException('Provider introuvable');

    const startsAt = input.startsAt ?? new Date();
    const duration = input.duration ?? TicketDurationPreset.D7;

    let expiresAt = input.expiresAt;
    if (!expiresAt) {
      expiresAt = computeExpiry(
        startsAt,
        duration,
        input.customDurationHours ? input.customDurationHours * 3_600_000 : undefined,
      );
    }
    if (expiresAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException("La date d'expiration doit etre posterieure au debut");
    }

    const username = (input.username ?? this.generateUsername()).trim();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new BadRequestException(
        'Identifiant invalide (3 a 32 caracteres : lettres, chiffres, . _ -)',
      );
    }

    const existing = await this.prisma.ticket.findUnique({ where: { username } });
    if (existing) throw new BadRequestException('Cet identifiant est deja utilise');

    const ticket = await this.prisma.ticket.create({
      data: {
        label: input.label,
        username,
        password: input.password ?? this.generatePassword(),
        providerId: input.providerId,
        startsAt,
        expiresAt,
        status: TicketStatus.ACTIVE,
        maxConnections: Math.max(
          1,
          input.maxConnections ?? this.appConfig.policies.defaultTicketMaxConnections,
        ),
        overflowPolicy: input.overflowPolicy ?? this.appConfig.policies.ticketOverflow,
        useCategoryFilter: input.useCategoryFilter ?? false,
        notes: input.notes ?? null,
        categories: input.categoryIds?.length
          ? {
              create: input.categoryIds.map((categoryId) => ({ categoryId })),
            }
          : undefined,
      },
    });

    this.logger.log(`Ticket cree: ${ticket.label} (${ticket.username}) jusqu'au ${ticket.expiresAt.toISOString()}`);
    return this.toView(ticket);
  }

  async list(options: { status?: TicketStatus; search?: string } = {}): Promise<TicketView[]> {
    const where: Prisma.TicketWhereInput = {};
    if (options.status) where.status = options.status;
    if (options.search) {
      where.OR = [
        { label: { contains: options.search, mode: 'insensitive' } },
        { username: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    const tickets = await this.prisma.ticket.findMany({
      where,
      include: { provider: true, categories: true },
      orderBy: { createdAt: 'desc' },
    });

    return tickets.map((ticket) => this.toView(ticket));
  }

  async get(ticketId: string): Promise<TicketView> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { provider: true, categories: true },
    });
    if (!ticket) throw new NotFoundException('Ticket introuvable');
    return this.toView(ticket);
  }

  async findByUsername(username: string): Promise<Ticket | null> {
    return this.prisma.ticket.findUnique({ where: { username } });
  }

  async update(ticketId: string, input: UpdateTicketInput): Promise<TicketView> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');

    const data: Prisma.TicketUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.maxConnections !== undefined) {
      data.maxConnections = Math.max(1, input.maxConnections);
    }
    if (input.overflowPolicy !== undefined) data.overflowPolicy = input.overflowPolicy;
    if (input.useCategoryFilter !== undefined) data.useCategoryFilter = input.useCategoryFilter;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.providerId !== undefined) {
      const provider = await this.prisma.upstreamProvider.findUnique({
        where: { id: input.providerId },
      });
      if (!provider) throw new NotFoundException('Provider introuvable');
      data.provider = { connect: { id: input.providerId } };
    }

    const updated = await this.prisma.ticket.update({ where: { id: ticketId }, data });

    if (input.categoryIds !== undefined) {
      await this.prisma.ticketCategory.deleteMany({ where: { ticketId } });
      if (input.categoryIds.length) {
        await this.prisma.ticketCategory.createMany({
          data: input.categoryIds.map((categoryId) => ({ ticketId, categoryId })),
        });
      }
    }

    return this.toView(updated);
  }

  async remove(ticketId: string): Promise<void> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');
    await this.prisma.ticket.delete({ where: { id: ticketId } });
    this.logger.log(`Ticket supprime: ${ticket.label}`);
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  /** Extends a ticket by the requested duration, from its current deadline. */
  async renew(
    ticketId: string,
    duration: TicketDurationPreset = TicketDurationPreset.D7,
    customDurationHours?: number,
  ): Promise<TicketView> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');

    const now = new Date();
    const base = renewalDeadline(ticket, now);
    const expiresAt = computeExpiry(
      base,
      duration,
      customDurationHours ? customDurationHours * 3_600_000 : undefined,
    );

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        expiresAt,
        status: ticket.status === TicketStatus.EXPIRED ? TicketStatus.ACTIVE : ticket.status,
      },
    });

    this.logger.log(`Ticket renouvele: ${ticket.label} -> ${expiresAt.toISOString()}`);
    return this.toView(updated);
  }

  async suspend(ticketId: string): Promise<TicketView> {
    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: TicketStatus.SUSPENDED },
    });
    return this.toView(updated);
  }

  async resume(ticketId: string): Promise<TicketView> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');

    const expired = ticket.expiresAt.getTime() <= Date.now();
    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: expired ? TicketStatus.EXPIRED : TicketStatus.ACTIVE },
    });
    return this.toView(updated);
  }

  async revoke(ticketId: string): Promise<TicketView> {
    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: TicketStatus.REVOKED },
    });
    return this.toView(updated);
  }

  async resetCredentials(ticketId: string): Promise<TicketView> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        username: this.generateUsername(),
        password: this.generatePassword(),
      },
    });
    return this.toView(updated);
  }

  /**
   * Cron job: flips expired tickets to EXPIRED.
   * Returns the number of tickets updated.
   */
  async expireDueTickets(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.ticket.updateMany({
      where: {
        status: TicketStatus.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: TicketStatus.EXPIRED },
    });

    if (result.count > 0) {
      this.logger.log(`${result.count} ticket(s) expire(s) et desactive(s)`);
    }
    return result.count;
  }

  /** Tickets expiring within the next `hours` window (dashboard). */
  async expiringSoon(hours = 72): Promise<TicketView[]> {
    const limit = new Date(Date.now() + hours * 3_600_000);
    const tickets = await this.prisma.ticket.findMany({
      where: {
        status: TicketStatus.ACTIVE,
        expiresAt: { lte: limit },
      },
      include: { provider: true, categories: true },
      orderBy: { expiresAt: 'asc' },
    });
    return tickets.map((ticket) => this.toView(ticket));
  }

  // -------------------------------------------------------------------------
  // Runtime validation
  // -------------------------------------------------------------------------

  /**
   * Validates a ticket for a streaming/API request.
   * Throws a precise error so the client can display a helpful message.
   */
  async assertUsable(ticket: Ticket, now: Date = new Date()): Promise<void> {
    const decision = evaluateTicket(ticket, now);

    if (decision.status !== TicketStatus.ACTIVE) {
      const messages: Record<string, string> = {
        EXPIRED: 'Votre acces a expire. Demandez un renouvellement.',
        SUSPENDED: 'Votre acces est suspendu. Contactez l’administrateur.',
        REVOKED: 'Cet acces a ete revoque.',
      };
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: messages[decision.status] ?? 'Acces indisponible.',
        user_info: {
          status: decision.status === TicketStatus.EXPIRED ? 'expired' : 'disabled',
          message: decision.reason,
        },
      });
    }
  }

  async touchConnection(ticketId: string, ip: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { lastConnectedAt: new Date(), lastIp: ip },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toView(ticket: Ticket): TicketView {
    const provider = (ticket as Ticket & { provider?: { name: string }; categories?: { categoryId: string }[] });
    const decision = evaluateTicket(ticket);

    return {
      id: ticket.id,
      label: ticket.label,
      username: ticket.username,
      password: ticket.password,
      providerId: ticket.providerId,
      providerName: provider.provider?.name ?? 'Inconnu',
      startsAt: ticket.startsAt,
      expiresAt: ticket.expiresAt,
      status: ticket.status,
      maxConnections: ticket.maxConnections,
      overflowPolicy: ticket.overflowPolicy,
      useCategoryFilter: ticket.useCategoryFilter,
      categoryIds: provider.categories?.map((link) => link.categoryId) ?? [],
      notes: ticket.notes,
      lastConnectedAt: ticket.lastConnectedAt,
      lastIp: ticket.lastIp,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      effectiveStatus: decision.status,
      remainingMs: decision.remainingMs,
    };
  }

  private generateUsername(): string {
    let username = 't';
    for (let i = 0; i < 9; i += 1) {
      username += USERNAME_ALPHABET[randomInt(USERNAME_ALPHABET.length)];
    }
    return username;
  }

  private generatePassword(): string {
    let password = '';
    for (let i = 0; i < 14; i += 1) {
      password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }
    return password;
  }
}
