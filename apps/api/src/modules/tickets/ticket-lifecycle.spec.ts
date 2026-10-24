import { TicketDurationPreset, TicketStatus } from '@prisma/client';
import {
  computeExpiry,
  DURATION_PRESETS,
  evaluateTicket,
  HOUR_MS,
  isTicketUsable,
  renewalDeadline,
} from './ticket-lifecycle';

describe('TicketLifecycle', () => {
  const now = new Date('2026-03-15T12:00:00.000Z');

  describe('computeExpiry', () => {
    it('applies the 24h preset', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.H24);
      expect(expiresAt.getTime() - now.getTime()).toBe(DURATION_PRESETS.H24);
      expect(expiresAt.toISOString()).toBe('2026-03-16T12:00:00.000Z');
    });

    it('applies the 7 days preset', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.D7);
      expect(expiresAt.getTime() - now.getTime()).toBe(7 * 24 * HOUR_MS);
    });

    it('applies the 30 days preset', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.D30);
      expect(expiresAt.getTime() - now.getTime()).toBe(30 * 24 * HOUR_MS);
    });

    it('applies a custom duration in milliseconds', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.CUSTOM, 3 * HOUR_MS);
      expect(expiresAt.getTime() - now.getTime()).toBe(3 * HOUR_MS);
    });

    it('never produces a duration shorter than one hour', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.CUSTOM, 60_000);
      expect(expiresAt.getTime() - now.getTime()).toBe(HOUR_MS);
    });

    it('falls back to 24h when the custom duration is missing', () => {
      const expiresAt = computeExpiry(now, TicketDurationPreset.CUSTOM);
      expect(expiresAt.getTime() - now.getTime()).toBe(DURATION_PRESETS.H24);
    });

    it('supports renewing from an arbitrary reference date', () => {
      const reference = new Date('2026-04-01T00:00:00.000Z');
      const expiresAt = computeExpiry(reference, TicketDurationPreset.D7);
      expect(expiresAt.toISOString()).toBe('2026-04-08T00:00:00.000Z');
    });
  });

  describe('evaluateTicket', () => {
    const base = {
      status: TicketStatus.ACTIVE,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-20T00:00:00.000Z'),
    };

    it('reports an active ticket as usable', () => {
      const decision = evaluateTicket(base, now);
      expect(decision.status).toBe(TicketStatus.ACTIVE);
      expect(decision.expired).toBe(false);
      expect(decision.remainingMs).toBe(base.expiresAt.getTime() - now.getTime());
    });

    it('detects an expired ticket even when the stored status says ACTIVE', () => {
      const decision = evaluateTicket(base, new Date('2026-03-21T00:00:00.000Z'));
      expect(decision.status).toBe(TicketStatus.EXPIRED);
      expect(decision.expired).toBe(true);
      expect(decision.remainingMs).toBe(0);
    });

    it('treats the exact expiry instant as expired', () => {
      const decision = evaluateTicket(base, base.expiresAt);
      expect(decision.expired).toBe(true);
      expect(decision.status).toBe(TicketStatus.EXPIRED);
    });

    it('treats one millisecond before the expiry as still valid', () => {
      const decision = evaluateTicket(
        base,
        new Date(base.expiresAt.getTime() - 1),
      );
      expect(decision.expired).toBe(false);
      expect(decision.status).toBe(TicketStatus.ACTIVE);
    });

    it('keeps a suspended ticket suspended even before its expiry', () => {
      const decision = evaluateTicket({ ...base, status: TicketStatus.SUSPENDED }, now);
      expect(decision.status).toBe(TicketStatus.SUSPENDED);
      expect(decision.expired).toBe(false);
      expect(decision.reason).toContain('suspendu');
    });

    it('keeps a revoked ticket revoked', () => {
      const decision = evaluateTicket({ ...base, status: TicketStatus.REVOKED }, now);
      expect(decision.status).toBe(TicketStatus.REVOKED);
      expect(decision.remainingMs).toBe(0);
    });

    it('refuses a ticket whose start date is in the future', () => {
      const future = {
        ...base,
        startsAt: new Date('2026-04-01T00:00:00.000Z'),
        expiresAt: new Date('2026-04-10T00:00:00.000Z'),
      };
      const decision = evaluateTicket(future, now);
      expect(decision.status).toBe(TicketStatus.PENDING);
      expect(decision.reason).toContain('pas encore valide');
      expect(isTicketUsable(future, now)).toBe(false);
    });

    it('derives the status from the dates: a stored EXPIRED ticket with a future expiry is active', () => {
      const decision = evaluateTicket({ ...base, status: TicketStatus.EXPIRED }, now);
      expect(decision.expired).toBe(false);
      expect(decision.status).toBe(TicketStatus.ACTIVE);
    });

    it('keeps a stored PENDING ticket pending while its start date is in the future', () => {
      const future = {
        ...base,
        status: TicketStatus.PENDING,
        startsAt: new Date('2026-04-01T00:00:00.000Z'),
        expiresAt: new Date('2026-04-10T00:00:00.000Z'),
      };
      expect(evaluateTicket(future, now).status).toBe(TicketStatus.PENDING);
    });
  });

  describe('isTicketUsable', () => {
    const ticket = {
      status: TicketStatus.ACTIVE,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-20T00:00:00.000Z'),
    };

    it('is true inside the validity window', () => {
      expect(isTicketUsable(ticket, now)).toBe(true);
    });

    it('is false after the validity window', () => {
      expect(isTicketUsable(ticket, new Date('2026-03-21T00:00:00.000Z'))).toBe(false);
    });

    it('is false when suspended', () => {
      expect(isTicketUsable({ ...ticket, status: TicketStatus.SUSPENDED }, now)).toBe(false);
    });
  });

  describe('renewalDeadline', () => {
    const ticket = {
      status: TicketStatus.ACTIVE,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-20T00:00:00.000Z'),
    };

    it('extends from the current expiry when the ticket is still valid', () => {
      expect(renewalDeadline(ticket, now).toISOString()).toBe('2026-03-20T00:00:00.000Z');
    });

    it('extends from now when the ticket has expired', () => {
      const expired = { ...ticket, status: TicketStatus.EXPIRED };
      expect(renewalDeadline(expired, now).toISOString()).toBe(now.toISOString());
    });

    it('extends from now when the expiry date is in the past but the status is active', () => {
      const stale = { ...ticket, expiresAt: new Date('2026-01-01T00:00:00.000Z') };
      expect(renewalDeadline(stale, now).toISOString()).toBe(now.toISOString());
    });
  });
});
