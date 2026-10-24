import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service';

/**
 * Builds the URLs exposed to the IPTV clients.
 *
 * Every URL points to the gateway, never to the upstream server: the
 * upstream credentials must never leave the API.
 */
@Injectable()
export class GatewayUrlService {
  constructor(private readonly appConfig: AppConfigService) {}

  get baseUrl(): string {
    return this.appConfig.gateway.publicBaseUrl;
  }

  live(username: string, password: string, streamId: string, extension = 'ts'): string {
    return `${this.baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${extension}`;
  }

  vod(username: string, password: string, streamId: string, extension = 'mp4'): string {
    return `${this.baseUrl}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${extension}`;
  }

  episode(username: string, password: string, streamId: string, extension = 'mp4'): string {
    return `${this.baseUrl}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${extension}`;
  }

  streamUrl(
    kind: 'live' | 'vod' | 'episode',
    username: string,
    password: string,
    streamId: string,
    extension?: string,
  ): string {
    switch (kind) {
      case 'live':
        return this.live(username, password, streamId, extension ?? 'ts');
      case 'vod':
        return this.vod(username, password, streamId, extension);
      case 'episode':
        return this.episode(username, password, streamId, extension);
      default:
        return this.live(username, password, streamId);
    }
  }
}
