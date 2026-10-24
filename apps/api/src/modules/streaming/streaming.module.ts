import { Module } from '@nestjs/common';
import { StreamHubService } from './stream-hub.service';
import { StreamingService } from './streaming.service';
import { HlsProxyService } from './hls-proxy.service';
import { HlsSegmentController, StreamController } from './stream.controller';
import { ContentModule } from '../content/content.module';

@Module({
  imports: [ContentModule],
  controllers: [StreamController, HlsSegmentController],
  providers: [StreamHubService, StreamingService, HlsProxyService],
  exports: [StreamHubService, StreamingService, HlsProxyService],
})
export class StreamingModule {}
