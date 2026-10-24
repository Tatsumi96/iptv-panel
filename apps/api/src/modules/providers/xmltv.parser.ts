import { UpstreamEpg } from './provider-adapter.port';

/**
 * Dependency-free XMLTV parser.
 *
 * XMLTV files for a big provider can be hundreds of megabytes; a streaming
 * regex scan is orders of magnitude faster (and lighter on memory) than
 * building a DOM, and we only need a flat list of programmes.
 */
export function parseXmltv(xml: string): UpstreamEpg[] {
  const results: UpstreamEpg[] = [];
  if (!xml) return results;

  const programmeRegex = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match: RegExpExecArray | null;

  while ((match = programmeRegex.exec(xml)) !== null) {
    const attributes = parseXmlAttributes(match[1]);
    const body = match[2];
    const start = attributes['start'];
    if (!start) continue;

    const stop = attributes['stop'] ?? start;
    results.push({
      id: attributes['id'] ?? '',
      epgId: attributes['channel'] ?? '',
      title: extractTag(body, 'title'),
      description: extractTag(body, 'desc') || undefined,
      lang: attributes['lang'],
      start: parseXmltvTime(start),
      stop: parseXmltvTime(stop),
      channelId: attributes['channel'] ?? '',
    });
  }

  return results;
}

export function parseXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

export function extractTag(body: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = regex.exec(body);
  return match ? decodeEntities(match[1].trim()) : '';
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `20240101120000 +0000` -> unix seconds (UTC). */
export function parseXmltvTime(value: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match;
  return Math.floor(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000,
  );
}
