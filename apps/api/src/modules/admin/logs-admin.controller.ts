import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma, StreamEndReason } from '@prisma/client';
import { IsBooleanString, IsDateString, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { IpBlockService } from '../security/ip-block.service';

class CreateIpBlockDto {
  @IsString()
  cidr!: string;

  @IsOptional()
  @IsString()
  ticketId?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsBooleanString()
  global?: boolean;
}

/** Viewing history and IP blocking. */
@Controller('api/admin')
@UseGuards(AdminAuthGuard)
export class LogsAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ipBlocks: IpBlockService,
  ) {}

  /** Watch history, filterable by ticket, IP or period. */
  @Get('logs')
  async logs(
    @Query('ticketId') ticketId?: string,
    @Query('ip') ip?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const where: Prisma.StreamLogWhereInput = {};
    if (ticketId) where.ticketId = ticketId;
    if (ip) where.clientIp = { contains: ip };
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    const take = Math.min(500, Math.max(1, Number(limit ?? 100)));

    const [items, total] = await this.prisma.$transaction([
      this.prisma.streamLog.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take,
        include: { ticket: { select: { label: true, username: true } } },
      }),
      this.prisma.streamLog.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        ticketId: item.ticketId,
        ticketLabel: item.ticket?.label ?? 'Ticket supprime',
        username: item.ticket?.username ?? '-',
        channelName: item.channelName,
        streamId: item.streamId,
        clientIp: item.clientIp,
        userAgent: item.userAgent,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        durationSec: item.durationSec,
        bytes: Number(item.bytes),
        endReason: item.endReason,
      })),
      total,
    };
  }

  /** Aggregated history per ticket. */
  @Get('logs/stats')
  async stats(@Query('days') days?: string) {
    const since = new Date(Date.now() - Math.min(90, Number(days ?? 7)) * 86_400_000);

    const grouped = await this.prisma.streamLog.groupBy({
      by: ['ticketId'],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
      _sum: { durationSec: true, bytes: true },
    });

    const tickets = await this.prisma.ticket.findMany({
      where: { id: { in: grouped.map((row) => row.ticketId ?? '').filter(Boolean) } },
      select: { id: true, label: true, username: true },
    });
    const labelById = new Map(tickets.map((ticket) => [ticket.id, ticket.label]));

    return grouped
      .map((row) => ({
        ticketId: row.ticketId,
        label: row.ticketId ? (labelById.get(row.ticketId) ?? 'Inconnu') : 'Inconnu',
        sessions: row._count._all,
        durationSec: row._sum.durationSec ?? 0,
        bytes: Number(row._sum.bytes ?? 0),
      }))
      .sort((a, b) => b.sessions - a.sessions);
  }

  @Get('ip-blocks')
  async listBlocks() {
    return { items: await this.ipBlocks.list() };
  }

  @Post('ip-blocks')
  async addBlock(@Body() body: CreateIpBlockDto) {
    return this.ipBlocks.add({
      cidr: body.cidr,
      ticketId: body.ticketId,
      reason: body.reason,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      scope: body.global ? 'GLOBAL' : undefined,
    });
  }

  @Delete('ip-blocks/:id')
  async removeBlock(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.ipBlocks.remove(id);
    return { deleted: true };
  }

  /** Distinct client IPs seen in the logs (helps spotting abusers). */
  @Get('known-clients')
  async knownClients(@Query('limit') limit?: string) {
    const take = Math.min(200, Math.max(1, Number(limit ?? 50)));
    const rows = await this.prisma.streamLog.findMany({
      where: { endedAt: null },
      orderBy: { startedAt: 'desc' },
      take: take * 4,
      select: { clientIp: true, ticketId: true, startedAt: true },
    });

    const seen = new Map<string, { ip: string; sessions: number; lastSeen: Date; ticketIds: string[] }>();
    for (const row of rows) {
      const entry = seen.get(row.clientIp) ?? {
        ip: row.clientIp,
        sessions: 0,
        lastSeen: row.startedAt,
        ticketIds: [],
      };
      entry.sessions += 1;
      if (row.startedAt > entry.lastSeen) entry.lastSeen = row.startedAt;
      if (row.ticketId && !entry.ticketIds.includes(row.ticketId)) {
        entry.ticketIds.push(row.ticketId);
      }
      seen.set(row.clientIp, entry);
    }

    return { items: [...seen.values()].slice(0, take) };
  }
}
