import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TicketDurationPreset, TicketStatus } from '@prisma/client';
import { IsBoolean, IsBooleanString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { TicketsService } from '../tickets/tickets.service';
import { GatewayUrlService } from '../xtream/gateway-url.service';
import { AppConfigService } from '../../common/config/app-config.service';

class CreateTicketDto {
  @IsString()
  label!: string;

  @IsString()
  providerId!: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsEnum(TicketDurationPreset)
  duration?: TicketDurationPreset;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  customDurationHours?: number;

  @IsOptional()
  @IsString()
  startsAt?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxConnections?: number;

  @IsOptional()
  @IsEnum(['REJECT', 'EVICT_OLDEST'])
  overflowPolicy?: 'REJECT' | 'EVICT_OLDEST';

  @IsOptional()
  @IsBooleanString()
  useCategoryFilter?: boolean;

  @IsOptional()
  @IsString()
  categoryIds?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdateTicketDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxConnections?: number;

  @IsOptional()
  @IsEnum(['REJECT', 'EVICT_OLDEST'])
  overflowPolicy?: 'REJECT' | 'EVICT_OLDEST';

  @IsOptional()
  @IsBooleanString()
  useCategoryFilter?: boolean;

  @IsOptional()
  @IsString()
  categoryIds?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  providerId?: string;
}

class RenewDto {
  @IsOptional()
  @IsEnum(TicketDurationPreset)
  duration?: TicketDurationPreset;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  customDurationHours?: number;
}

@Controller('api/admin/tickets')
@UseGuards(AdminAuthGuard)
export class TicketsAdminController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly urls: GatewayUrlService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: TicketStatus,
    @Query('search') search?: string,
  ) {
    const items = await this.tickets.list({
      status: status || undefined,
      search: search || undefined,
    });
    return { items };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const ticket = await this.tickets.get(id);
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post()
  async create(@Body() body: CreateTicketDto) {
    const ticket = await this.tickets.create({
      label: body.label,
      providerId: body.providerId,
      username: body.username,
      password: body.password,
      duration: body.duration,
      customDurationHours: body.customDurationHours,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      maxConnections: body.maxConnections,
      overflowPolicy: body.overflowPolicy,
      useCategoryFilter: body.useCategoryFilter,
      categoryIds: this.parseCategoryIds(body.categoryIds),
      notes: body.notes,
    });
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateTicketDto) {
    const ticket = await this.tickets.update(id, {
      label: body.label,
      maxConnections: body.maxConnections,
      overflowPolicy: body.overflowPolicy,
      useCategoryFilter: body.useCategoryFilter,
      categoryIds:
        body.categoryIds === undefined ? undefined : this.parseCategoryIds(body.categoryIds),
      notes: body.notes,
      providerId: body.providerId,
    });
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post(':id/renew')
  async renew(@Param('id') id: string, @Body() body: RenewDto) {
    const ticket = await this.tickets.renew(
      id,
      body.duration ?? TicketDurationPreset.D7,
      body.customDurationHours,
    );
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post(':id/suspend')
  async suspend(@Param('id') id: string) {
    const ticket = await this.tickets.suspend(id);
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    const ticket = await this.tickets.resume(id);
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post(':id/revoke')
  async revoke(@Param('id') id: string) {
    const ticket = await this.tickets.revoke(id);
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Post(':id/reset-credentials')
  async resetCredentials(@Param('id') id: string) {
    const ticket = await this.tickets.resetCredentials(id);
    return { ...ticket, connectionInfo: this.connectionInfo(ticket) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.tickets.remove(id);
    return { deleted: true };
  }

  /** Ready-to-send message and QR payload for the ticket holder. */
  @Get(':id/share')
  async share(@Param('id') id: string) {
    const ticket = await this.tickets.get(id);
    const host = this.urls.baseUrl;

    const message = [
      `Bonjour,`,
      ``,
      `Voici vos acces TV (${ticket.label}) :`,
      `Serveur : ${host}`,
      `Identifiant : ${ticket.username}`,
      `Mot de passe : ${ticket.password}`,
      `Valide jusqu'au : ${ticket.expiresAt.toLocaleString('fr-FR')}`,
      ``,
      `Dans IPTV Smarters ou TiviMate, choisissez "Xtream Codes" puis saisissez ces informations.`,
    ].join('\n');

    return {
      ticketId: ticket.id,
      username: ticket.username,
      password: ticket.password,
      server: host,
      expiresAt: ticket.expiresAt.toISOString(),
      message,
      qrPayload: JSON.stringify({
        server: host,
        username: ticket.username,
        password: ticket.password,
      }),
    };
  }

  private parseCategoryIds(raw?: string): string[] | undefined {
    if (raw === undefined) return undefined;
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to CSV parsing */
    }
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private connectionInfo(ticket: { username: string; password: string }) {
    const host = this.urls.baseUrl;
    return {
      server: host,
      username: ticket.username,
      password: ticket.password,
      xtreamLoginUrl: `${host}/player_api.php?username=${encodeURIComponent(ticket.username)}&password=${encodeURIComponent(ticket.password)}`,
      m3uUrl: `${host}/get.php?username=${encodeURIComponent(ticket.username)}&password=${encodeURIComponent(ticket.password)}&type=m3u_plus&output=ts`,
    };
  }
}
