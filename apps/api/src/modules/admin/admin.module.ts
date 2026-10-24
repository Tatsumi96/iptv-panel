import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { TicketsAdminController } from './tickets-admin.controller';
import { ProvidersAdminController } from './providers-admin.controller';
import { LogsAdminController } from './logs-admin.controller';
import { AuthModule } from '../auth/auth.module';
import { ContentModule } from '../content/content.module';
import { StreamingModule } from '../streaming/streaming.module';
import { XtreamModule } from '../xtream/xtream.module';

@Module({
  imports: [AuthModule, ContentModule, StreamingModule, XtreamModule],
  controllers: [
    DashboardController,
    TicketsAdminController,
    ProvidersAdminController,
    LogsAdminController,
  ],
})
export class AdminModule {}
