import { TicketDurationPreset, TicketStatus } from '@prisma/client';

export interface TicketLifecycleInput {
  status: TicketStatus;
  startsAt: Date;
  expiresAt: Date;
}

export interface ExpiryDecision {
  /** Status actually applicable right now (may differ from the stored one). */
  status: TicketStatus;
  expired: boolean;
  /** Remaining milliseconds before expiry; 0 when already expired. */
  remainingMs: number;
  /** Human readable reason, useful for logs and API payloads. */
  reason?: string;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Duration (in ms) matching each preset. */
export const DURATION_PRESETS: Record<Exclude<TicketDurationPreset, 'CUSTOM'>, number> = {
  H24: DAY_MS,
  D7: 7 * DAY_MS,
  D30: 30 * DAY_MS,
};

/**
 * Computes the expiry date for a ticket.
 *
 * The end date is exclusive: a ticket created at 10:00 with a 24h preset is
 * valid until 10:00 the next day (inclusive of that exact second).
 */
export function computeExpiry(
  startsAt: Date,
  preset: TicketDurationPreset,
  customDurationMs?: number,
  reference?: Date,
): Date {
  const base = reference ?? startsAt;
  if (preset === TicketDurationPreset.CUSTOM) {
    const duration = Math.max(HOUR_MS, Math.trunc(customDurationMs ?? DAY_MS));
    return new Date(base.getTime() + duration);
  }
  return new Date(base.getTime() + DURATION_PRESETS[preset]);
}

/**
 * Single source of truth for the state of a ticket.
 *
 * The stored status can be stale (a ticket may expire between two cron
 * runs), so the effective status is always recomputed from the dates:
 * - SUSPENDED / REVOKED are explicit admin decisions and are always honoured.
 * - PENDING / EXPIRED / ACTIVE are derived from `startsAt` and `expiresAt`,
 *   so a renewal that moves the expiry date forward reactivates the ticket.
 */
export function evaluateTicket(
  ticket: TicketLifecycleInput,
  now: Date = new Date(),
): ExpiryDecision {
  if (ticket.status === TicketStatus.SUSPENDED) {
    return {
      status: TicketStatus.SUSPENDED,
      expired: false,
      remainingMs: Math.max(0, ticket.expiresAt.getTime() - now.getTime()),
      reason: 'Ticket suspendu par un administrateur',
    };
  }

  if (ticket.status === TicketStatus.REVOKED) {
    return {
      status: TicketStatus.REVOKED,
      expired: false,
      remainingMs: 0,
      reason: 'Ticket revoque',
    };
  }

  if (ticket.startsAt.getTime() > now.getTime()) {
    return {
      status: TicketStatus.PENDING,
      expired: false,
      remainingMs: ticket.expiresAt.getTime() - now.getTime(),
      reason: "Le ticket n'est pas encore valide",
    };
  }

  const remainingMs = ticket.expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return {
      status: TicketStatus.EXPIRED,
      expired: true,
      remainingMs: 0,
      reason: 'Ticket expire',
    };
  }

  return {
    status: TicketStatus.ACTIVE,
    expired: false,
    remainingMs,
  };
}

/** True when the ticket may open a new stream right now. */
export function isTicketUsable(ticket: TicketLifecycleInput, now: Date = new Date()): boolean {
  return evaluateTicket(ticket, now).status === TicketStatus.ACTIVE;
}

/**
 * Renewal semantics: extend from the current expiry date when the ticket is
 * still valid, otherwise from now (so a renewal never creates a past expiry).
 */
export function renewalDeadline(
  ticket: TicketLifecycleInput,
  now: Date = new Date(),
): Date {
  const base =
    ticket.expiresAt.getTime() > now.getTime() && ticket.status === TicketStatus.ACTIVE
      ? ticket.expiresAt
      : now;
  return base;
}
