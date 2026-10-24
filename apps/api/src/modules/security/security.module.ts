import { Global, Module } from '@nestjs/common';
import { IpBlockService } from './ip-block.service';

@Global()
@Module({
  providers: [IpBlockService],
  exports: [IpBlockService],
})
export class SecurityModule {}
