import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { ContentModule } from '../content/content.module';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [ScheduleModule.forRoot(), ContentModule, StreamingModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
