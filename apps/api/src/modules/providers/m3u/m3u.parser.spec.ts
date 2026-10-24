import { buildGroupsFromEntries, parseM3U } from './m3u.parser';

/**
 * The M3U parser is the entry point of the "M3U as a provider" feature:
 * it converts a raw playlist into the structure exposed through the
 * Xtream-compatible API.
 */
describe('M3U parser', () => {
  const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="france2.fr" tvg-name="France 2" tvg-logo="http://logo/f2.png" group-title="France",France 2
http://provider/live/france2.ts
#EXTINF:-1 tvg-id="tf1.fr" tvg-name="TF1" group-title="France | General",TF1
http://provider/live/tf1.ts
#EXTINF:-1 group-title="Sport",Canal+ Sport
https://provider/hls/sport.m3u8
#EXTINF:-1,Film sans extension
http://provider/movies/film
`;

  it('parses every entry', () => {
    const entries = parseM3U(playlist);
    expect(entries).toHaveLength(4);
  });

  it('reads the display name', () => {
    const entries = parseM3U(playlist);
    expect(entries[0].name).toBe('France 2');
    expect(entries[2].name).toBe('Canal+ Sport');
  });

  it('reads the tvg attributes', () => {
    const entries = parseM3U(playlist);
    expect(entries[0].tvgId).toBe('france2.fr');
    expect(entries[0].tvgLogo).toBe('http://logo/f2.png');
    expect(entries[0].groupTitle).toBe('France');
  });

  it('keeps the media URL untouched', () => {
    const entries = parseM3U(playlist);
    expect(entries[0].url).toBe('http://provider/live/france2.ts');
    expect(entries[2].url).toBe('https://provider/hls/sport.m3u8');
  });

  it('detects VOD entries by extension', () => {
    const entries = parseM3U(playlist);
    expect(entries[0].isVod).toBe(false);
    expect(entries[3].isVod).toBe(false);

    const vod = parseM3U('#EXTINF:-1,Film\nhttp://provider/movies/film.mp4');
    expect(vod[0].isVod).toBe(true);
  });

  it('ignores comments and directives', () => {
    const entries = parseM3U(playlist);
    expect(entries.every((entry) => entry.url.startsWith('http'))).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const entries = parseM3U(playlist.replace(/\n/g, '\r\n'));
    expect(entries).toHaveLength(4);
    expect(entries[0].name).toBe('France 2');
  });

  it('returns an empty list for an empty playlist', () => {
    expect(parseM3U('')).toEqual([]);
  });

  it('derives a name from the URL when #EXTINF is missing', () => {
    const entries = parseM3U('http://provider/live/chainename.ts');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('chainename');
  });

  it('builds the category tree from the group titles', () => {
    const entries = parseM3U(playlist);
    const groups = buildGroupsFromEntries(entries);

    expect(groups.has('France')).toBe(true);
    expect(groups.get('France')).toEqual([]);
    expect(groups.get('General')).toEqual(['France']);
  });
});
