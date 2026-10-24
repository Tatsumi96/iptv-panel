import { OverflowPolicy } from '@prisma/client';
import {
  evaluateTicketLimit,
  evaluateUpstreamLimit,
  sharesUpstreamFeed,
} from './connection-limits';

describe('connection-limits', () => {
  describe('evaluateTicketLimit', () => {
    it('allows the first session on a single-connection ticket', () => {
      const decision = evaluateTicketLimit(0, 1, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(true);
      expect(decision.action).toBe('ALLOW');
      expect(decision.resultingCount).toBe(1);
    });

    it('rejects the second session on a single-connection ticket', () => {
      const decision = evaluateTicketLimit(1, 1, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(false);
      expect(decision.action).toBe('REJECT');
      expect(decision.reason).toContain('Un seul appareil');
    });

    it('allows up to maxConnections sessions', () => {
      for (let current = 0; current < 5; current += 1) {
        const decision = evaluateTicketLimit(current, 5, OverflowPolicy.REJECT);
        expect(decision.allowed).toBe(true);
      }
    });

    it('rejects the session that exceeds maxConnections', () => {
      const decision = evaluateTicketLimit(5, 5, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('5 connexions simultanees');
    });

    it('evicts the oldest session when the policy allows it', () => {
      const decision = evaluateTicketLimit(1, 1, OverflowPolicy.EVICT_OLDEST);
      expect(decision.allowed).toBe(true);
      expect(decision.action).toBe('EVICT_OLDEST');
      expect(decision.resultingCount).toBe(1);
    });

    it('never lets the resulting count exceed the maximum', () => {
      for (let current = 0; current < 10; current += 1) {
        const decision = evaluateTicketLimit(current, 3, OverflowPolicy.EVICT_OLDEST);
        expect(decision.resultingCount).toBeLessThanOrEqual(3);
      }
    });

    it('treats a zero maximum as one (defensive)', () => {
      const decision = evaluateTicketLimit(0, 0, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(true);
      expect(evaluateTicketLimit(1, 0, OverflowPolicy.REJECT).allowed).toBe(false);
    });
  });

  describe('evaluateUpstreamLimit', () => {
    it('allows a connection while below the account limit', () => {
      const decision = evaluateUpstreamLimit(0, 2, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(true);
      expect(decision.resultingCount).toBe(1);
    });

    it('rejects the connection that would exceed the account limit', () => {
      const decision = evaluateUpstreamLimit(2, 2, OverflowPolicy.REJECT);
      expect(decision.allowed).toBe(false);
      expect(decision.action).toBe('REJECT');
      expect(decision.reason).toContain('limite de connexions');
    });

    it('never exceeds the upstream maximum under the evict policy', () => {
      for (let current = 0; current < 10; current += 1) {
        const decision = evaluateUpstreamLimit(current, 2, OverflowPolicy.EVICT_OLDEST);
        expect(decision.resultingCount).toBeLessThanOrEqual(2);
      }
    });

    it('refuses to evict when there is no feed to evict', () => {
      const decision = evaluateUpstreamLimit(0, 0, OverflowPolicy.EVICT_OLDEST);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('sharesUpstreamFeed', () => {
    const feeds = [
      { feedKey: 'provider-1:live:42' },
      { feedKey: 'provider-1:live:43' },
    ];

    it('detects a stream already being consumed', () => {
      expect(sharesUpstreamFeed('provider-1:live:42', feeds)).toBe(true);
    });

    it('detects a stream that is not consumed yet', () => {
      expect(sharesUpstreamFeed('provider-1:live:99', feeds)).toBe(false);
    });

    it('does not share a feed across providers', () => {
      expect(sharesUpstreamFeed('provider-2:live:42', feeds)).toBe(false);
    });

    it('does not share a feed across stream kinds', () => {
      expect(sharesUpstreamFeed('provider-1:vod:42', feeds)).toBe(false);
    });
  });
});
