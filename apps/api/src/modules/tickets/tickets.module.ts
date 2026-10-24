import { Global, Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';

@Global()
@Module({
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
