import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { AppConfigService } from '../../common/config/app-config.service';

const SIGNATURE_TTL_MS = 10 * 60 * 1000;

/**
 * HLS (.m3u8) proxy.
 *
 * Xtream servers expose HLS playlists whose segment URLs point to the
 * upstream host. The gateway rewrites them into signed gateway URLs so the
 * client never sees (and cannot abuse) the upstream address.
 */
@Injectable()
export class HlsProxyService {
  private readonly logger = new Logger(HlsProxyService.name);
  private readonly httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

  constructor(private readonly appConfig: AppConfigService) {}

  private signature(url: string): string {
    return createHmac('sha256', this.appConfig.encryptionKey)
      .update(url)
      .digest('base64url')
      .slice(0, 32);
  }

  /** Builds a signed gateway URL for an upstream segment. */
  buildSegmentUrl(upstreamUrl: string): string {
    const encoded = Buffer.from(upstreamUrl, 'utf8').toString('base64url');
    const signature = this.signature(upstreamUrl);
    return `${this.appConfig.gateway.publicBaseUrl}/hlsseg?u=${encoded}&s=${signature}`;
  }

  /** Validates a signed segment URL. */
  verify(encodedUrl: string, signature: string): string | null {
    try {
      const upstreamUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8');
      if (!upstreamUrl.startsWith('http://') && !upstreamUrl.startsWith('https://')) {
        return null;
      }
      const expected = this.signature(upstreamUrl);
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return null;
      }
      return upstreamUrl;
    } catch {
      return null;
    }
  }

  /**
   * Fetches an upstream playlist and rewrites every segment URI.
   */
  async rewritePlaylist(upstreamUrl: string, username: string, password: string): Promise<string> {
    const response = await this.fetchText(upstreamUrl);
    const base = new URL(upstreamUrl);

    const lines = response.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Media segment / playlist URI.
      if (!trimmed.startsWith('#')) {
        try {
          const absolute = new URL(trimmed, base).toString();
          return this.buildSegmentUrl(absolute);
        } catch {
          return line;
        }
      }

      // URI="..." attribute inside #EXT-X-KEY / #EXT-X-MEDIA.
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
        try {
          const absolute = new URL(uri, base).toString();
          return `URI="${this.buildSegmentUrl(absolute)}"`;
        } catch {
          return _match;
        }
      });
    });

    void username;
    void password;
    return lines.join('\n');
  }

  async fetchText(url: string): Promise<string> {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<string>((resolve, reject) => {
      const req = client(
        parsed,
        {
          method: 'GET',
          agent: parsed.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
          headers: { 'User-Agent': 'IPTV-Home-Gateway/1.0', Accept: '*/*' },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            this.fetchText(next).then(resolve, reject);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
      req.setTimeout(20_000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
  }

  /** Streams a segment (or any binary upstream resource) to the client. */
  async pipeSegment(
    upstreamUrl: string,
    write: (chunk: Buffer) => void,
    end: () => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const parsed = new URL(upstreamUrl);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = client(
      parsed,
      {
        method: 'GET',
        agent: parsed.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
        headers: { 'User-Agent': 'IPTV-Home-Gateway/1.0', Accept: '*/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, upstreamUrl).toString();
          void this.pipeSegment(next, write, end, onError);
          return;
        }
        if (status !== 200) {
          res.resume();
          onError(new Error(`HTTP ${status}`));
          return;
        }
        res.on('data', (chunk: Buffer) => write(chunk));
        res.on('end', () => end());
        res.on('error', (error) => onError(error));
      },
    );

    req.on('error', onError);
    req.setTimeout(30_000, () => req.destroy(new Error('Timeout')));
    req.end();
  }
}
