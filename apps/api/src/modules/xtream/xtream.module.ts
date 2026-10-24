import { Module } from '@nestjs/common';
import { PlayerApiController } from './player-api.controller';
import { GetPhpController } from './get-php.controller';
import { XmltvController } from './xmltv.controller';
import { GatewayUrlService } from './gateway-url.service';
import { ContentModule } from '../content/content.module';

@Module({
  imports: [ContentModule],
  controllers: [PlayerApiController, GetPhpController, XmltvController],
  providers: [GatewayUrlService],
  exports: [GatewayUrlService],
})
export class XtreamModule {}
