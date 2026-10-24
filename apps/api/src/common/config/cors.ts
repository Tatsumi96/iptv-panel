/**
 * CORS origin matching.
 *
 * The admin panel is reachable from the local network, and the server IP may
 * change (DHCP). A plain list of origins would then break the panel: the
 * browser silently refuses the API responses and every page looks empty.
 *
 * A pattern may therefore contain `*` wildcards:
 *   http://192.168.*.*:8080   ->  every host of the 192.168.0.0/16 network
 */
export function matchesCorsOrigin(pattern: string, origin: string): boolean {
  const wanted = pattern.trim();
  if (!wanted) return false;
  if (wanted === '*') return true;
  if (!wanted.includes('*')) return wanted === origin;

  const escaped = wanted.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(origin);
}

/**
 * Checks an origin against the list of allowed patterns.
 * An empty list allows every origin (development setup).
 */
export function isOriginAllowed(patterns: string[], origin: string): boolean {
  if (!patterns.length) return true;
  if (!origin) return true;
  return patterns.some((pattern) => matchesCorsOrigin(pattern, origin));
}
