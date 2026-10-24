import { cidrContains, ipToLong } from './ip-block.service';

describe('IP blocking', () => {
  describe('ipToLong', () => {
    it('converts an IPv4 address', () => {
      expect(ipToLong('192.168.1.1')).toBe(3232235777);
      expect(ipToLong('0.0.0.0')).toBe(0);
      expect(ipToLong('255.255.255.255')).toBe(4294967295);
    });

    it('returns null for an invalid address', () => {
      expect(ipToLong('192.168.1')).toBeNull();
      expect(ipToLong('192.168.1.256')).toBeNull();
      expect(ipToLong('not-an-ip')).toBeNull();
    });
  });

  describe('cidrContains', () => {
    it('matches a /32 exactly', () => {
      expect(cidrContains('192.168.1.10/32', '192.168.1.10')).toBe(true);
      expect(cidrContains('192.168.1.10/32', '192.168.1.11')).toBe(false);
    });

    it('matches a /24 range', () => {
      expect(cidrContains('192.168.1.0/24', '192.168.1.55')).toBe(true);
      expect(cidrContains('192.168.1.0/24', '192.168.2.55')).toBe(false);
    });

    it('matches a /16 range', () => {
      expect(cidrContains('192.168.0.0/16', '192.168.44.2')).toBe(true);
      expect(cidrContains('192.168.0.0/16', '192.169.44.2')).toBe(false);
    });

    it('treats a bare address as a /32', () => {
      expect(cidrContains('10.1.2.3', '10.1.2.3')).toBe(true);
      expect(cidrContains('10.1.2.3', '10.1.2.4')).toBe(false);
    });

    it('matches everything with a /0', () => {
      expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
    });

    it('matches an exact IPv6 address', () => {
      expect(cidrContains('2001:db8::1', '2001:db8::1')).toBe(true);
      expect(cidrContains('2001:db8::1', '2001:db8::2')).toBe(false);
    });

    it('does not match malformed input', () => {
      expect(cidrContains('192.168.1.0/24', 'garbage')).toBe(false);
    });
  });
});
