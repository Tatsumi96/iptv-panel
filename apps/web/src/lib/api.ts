/**
 * Base URL of the administration API.
 *
 * Empty by default: the panel is served by the same nginx instance that
 * proxies `/api/` to the API, so the requests stay on the same origin. The
 * panel therefore works whatever the IP address of the server is, without
 * having to rebuild the image.
 *
 * `NEXT_PUBLIC_API_URL` can still be set to target a different API host.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('iptv_access_token');
}

function setAuth(accessToken: string) {
  localStorage.setItem('iptv_access_token', accessToken);
}

function clearAuth() {
  localStorage.removeItem('iptv_access_token');
}

function isAuthenticated(): boolean {
  return !!getAccessToken();
}

async function api(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...options, headers });
}

export { API_URL, api, clearAuth, getAccessToken, isAuthenticated, setAuth };
