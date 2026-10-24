/**
 * M3U / M3U8 playlist parser.
 *
 * Pure functions, no I/O — easy to unit test and reusable by the
 * "M3U as a provider" ingestion pipeline.
 */

export interface M3uEntry {
  /** Display name of the entry. */
  name: string;
  /** Direct media URL. */
  url: string;
  /** tvg-id attribute (usually the EPG channel id). */
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  /** group-title attribute, used to build the Xtream category tree. */
  groupTitle?: string;
  /** Channel number / tvg-chno. */
  channelNumber?: string;
  /** Every parsed attribute of the #EXTINF line. */
  attributes: Record<string, string>;
  /** Whether the entry points to a VOD file rather than a live stream. */
  isVod: boolean;
  /** Duration in seconds when the playlist declares one (#EXTVODOPT / #EXTINF with duration). */
  durationSec?: number;
}

const VOD_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.ts.mp4']);

const ATTRIBUTE_REGEX = /([A-Za-z0-9_-]+)="([^"]*)"/g;

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTRIBUTE_REGEX.lastIndex = 0;
  while ((match = ATTRIBUTE_REGEX.exec(raw)) !== null) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

function isVodUrl(url: string): boolean {
  const clean = url.split('?')[0].toLowerCase();
  for (const ext of VOD_EXTENSIONS) {
    if (clean.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Parses an extended M3U playlist.
 * Tolerates CRLF, missing #EXTM3U header, `#EXTINF` without attributes and
 * plain URL lines.
 */
export function parseM3U(content: string): M3uEntry[] {
  const entries: M3uEntry[] = [];
  if (!content) return entries;

  const lines = content.split(/\r?\n/);
  let pending: {
    name: string;
    attributes: Record<string, string>;
    durationSec?: number;
  } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const payload = line.slice('#EXTINF:'.length);
      const durationMatch = payload.match(/^(?<dur>-?[\d.]+)\s*,/);
      const durationSec = durationMatch
        ? Math.round(Math.abs(parseFloat(durationMatch.groups?.dur ?? '0')))
        : undefined;
      const commaIndex = payload.indexOf(',');
      const name = commaIndex >= 0 ? payload.slice(commaIndex + 1).trim() : payload.trim();
      const attributePart = commaIndex >= 0 ? payload.slice(0, commaIndex) : payload;
      pending = {
        name,
        attributes: parseAttributes(attributePart),
        durationSec,
      };
      continue;
    }

    if (line.startsWith('#EXTVODOPT:')) {
      if (pending) {
        const durationMatch = line.match(/duration:([\d.]+)/i);
        if (durationMatch) {
          pending.durationSec = Math.round(parseFloat(durationMatch[1]));
        }
      }
      continue;
    }

    if (line.startsWith('#')) continue; // other directives (#EXTM3U, #EXTGRP, ...)

    if (!/^https?:\/\//i.test(line) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      continue;
    }

    const attributes = pending?.attributes ?? {};
    entries.push({
      name: pending?.name || fallbackName(line),
      url: line,
      tvgId: attributes['tvg-id'],
      tvgName: attributes['tvg-name'],
      tvgLogo: attributes['tvg-logo'] || attributes['logo'],
      groupTitle: attributes['group-title'],
      channelNumber: attributes['tvg-chno'] || attributes['chno'],
      attributes,
      isVod: isVodUrl(line),
      durationSec: pending?.durationSec,
    });

    pending = null;
  }

  return entries;
}

/** Derive a readable name from the URL when the playlist has no #EXTINF. */
function fallbackName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return (last ?? parsed.hostname).replace(/\.[a-z0-9]+$/i, '') || parsed.hostname;
  } catch {
    return url.split('/').pop() ?? url;
  }
}

/**
 * Builds the category tree from the `group-title` attributes.
 * Groups are normalised: "Sports | Football" becomes a hierarchy.
 */
export function buildGroupsFromEntries(entries: M3uEntry[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const raw = (entry.groupTitle ?? '').trim();
    if (!raw) continue;
    const normalized = raw.split('|').map((part) => part.trim()).filter(Boolean);
    const leaf = normalized.length ? normalized[normalized.length - 1] : raw;
    const parent = normalized.length > 1 ? normalized[normalized.length - 2] : undefined;
    const set = groups.get(leaf) ?? [];
    if (parent && !set.includes(parent)) set.push(parent);
    groups.set(leaf, set);
  }
  return groups;
}
