import { isOriginAllowed, matchesCorsOrigin } from './cors';

describe('CORS origin matching', () => {
  it('matches an exact origin', () => {
    expect(matchesCorsOrigin('http://192.168.1.193:8080', 'http://192.168.1.193:8080')).toBe(true);
    expect(matchesCorsOrigin('http://192.168.1.193:8080', 'http://192.168.1.194:8080')).toBe(false);
  });

  it('matches a wildcard pattern', () => {
    expect(matchesCorsOrigin('http://192.168.*.*:8080', 'http://192.168.1.193:8080')).toBe(true);
    expect(matchesCorsOrigin('http://192.168.*.*:8080', 'http://192.168.12.34:8080')).toBe(true);
    expect(matchesCorsOrigin('http://192.168.*.*:8080', 'http://10.0.0.1:8080')).toBe(false);
  });

  it('does not match a different port', () => {
    expect(matchesCorsOrigin('http://192.168.*.*:8080', 'http://192.168.1.193:3001')).toBe(false);
  });

  it('allows every origin when no pattern is configured', () => {
    expect(isOriginAllowed([], 'http://anything.example')).toBe(true);
  });

  it('accepts a request without origin (native app, curl)', () => {
    expect(isOriginAllowed(['http://localhost:8080'], '')).toBe(true);
  });

  it('rejects an origin outside of the patterns', () => {
    expect(isOriginAllowed(['http://localhost:8080'], 'http://192.168.1.193:8080')).toBe(false);
  });

  it('accepts an origin matching one of the patterns', () => {
    const patterns = ['http://localhost:8080', 'http://192.168.*.*:8080'];
    expect(isOriginAllowed(patterns, 'http://192.168.1.193:8080')).toBe(true);
    expect(isOriginAllowed(patterns, 'http://localhost:8080')).toBe(true);
    expect(isOriginAllowed(patterns, 'http://evil.example')).toBe(false);
  });
});
