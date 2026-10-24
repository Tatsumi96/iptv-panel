import { Global, Module } from '@nestjs/common';
import { HttpClientFactory } from './http-client.factory';
import { ProviderAdapterFactory } from './provider-adapter.factory';
import { ProvidersService } from './providers.service';

@Global()
@Module({
  providers: [HttpClientFactory, ProviderAdapterFactory, ProvidersService],
  exports: [HttpClientFactory, ProviderAdapterFactory, ProvidersService],
})
export class ProvidersModule {}
