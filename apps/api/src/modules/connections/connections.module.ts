import { Global, Module } from '@nestjs/common';
import { ConnectionRegistryService } from './connection-registry.service';

@Global()
@Module({
  providers: [ConnectionRegistryService],
  exports: [ConnectionRegistryService],
})
export class ConnectionsModule {}
