import { Injectable, Logger } from '@nestjs/common';
import { IpBlock, IpBlockScope, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface IpRule {
  id: string;
  cidr: string;
  scope: IpBlockScope;
  ticketId: string | null;
  reason: string | null;
  expiresAt: Date | null;
  hits: number;
  createdAt: Date;
}

/**
 * IP address matching helpers.
 * Supports IPv4 CIDR and exact IPv6 addresses (prefix matching for v6 is
 * approximated by a /64 default, which is the residential allocation size).
 */
export function ipToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = value * 256 + num;
  }
  return value >>> 0;
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [range, prefixRaw] = cidr.split('/');
  const prefix = prefixRaw === undefined ? undefined : Number(prefixRaw);

  if (range.includes(':')) {
    // IPv6: exact match, or /64 prefix match.
    if (prefix === undefined) return range === ip;
    const normalized = ip.toLowerCase();
    const target = normalized.startsWith(range.toLowerCase()) ? normalized : null;
    if (!target) return false;
    return prefix <= 64 && range.toLowerCase() === normalized.slice(0, normalized.indexOf(':'));
  }

  const rangeValue = ipToLong(range);
  const ipValue = ipToLong(ip);
  if (rangeValue === null || ipValue === null) return false;

  const bits = prefix === undefined ? 32 : Math.max(0, Math.min(32, prefix));
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((rangeValue & mask) >>> 0) === ((ipValue & mask) >>> 0);
}

@Injectable()
export class IpBlockService {
  private readonly logger = new Logger(IpBlockService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(options: { scope?: IpBlockScope; ticketId?: string } = {}): Promise<IpRule[]> {
    const where: Prisma.IpBlockWhereInput = {};
    if (options.scope) where.scope = options.scope;
    if (options.ticketId) where.ticketId = options.ticketId;
    return this.prisma.ipBlock.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async add(input: {
    cidr: string;
    scope?: IpBlockScope;
    ticketId?: string;
    reason?: string;
    expiresAt?: Date;
  }): Promise<IpRule> {
    const cidr = input.cidr.trim();
    if (!cidr) throw new Error('Adresse IP invalide');

    const ticketId = input.ticketId ?? null;
    if (ticketId) {
      const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new Error('Ticket introuvable');
    }

    const block = await this.prisma.ipBlock.create({
      data: {
        cidr,
        scope: input.scope ?? (ticketId ? IpBlockScope.TICKET : IpBlockScope.GLOBAL),
        ticketId,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    this.logger.log(`IP bloquee: ${cidr} (${block.scope})`);
    return block;
  }

  async remove(id: string): Promise<void> {
    await this.prisma.ipBlock.delete({ where: { id } }).catch(() => undefined);
  }

  /**
   * Checks an IP against the active rules.
   * Returns the blocking rule when the address is not allowed.
   */
  async findBlockingRule(ip: string, ticketId?: string): Promise<IpBlock | null> {
    const now = new Date();
    const rules = await this.prisma.ipBlock.findMany({
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });

    for (const rule of rules) {
      if (!cidrContains(rule.cidr, ip)) continue;
      if (rule.scope === IpBlockScope.GLOBAL) return rule;
      if (ticketId && rule.ticketId === ticketId) return rule;
    }
    return null;
  }

  async isBlocked(ip: string, ticketId?: string): Promise<boolean> {
    return Boolean(await this.findBlockingRule(ip, ticketId));
  }
}
