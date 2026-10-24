import { OverflowPolicy } from '@prisma/client';

export type LimitAction = 'ALLOW' | 'REJECT' | 'EVICT_OLDEST';

export interface LimitDecision {
  action: LimitAction;
  allowed: boolean;
  reason?: string;
  /** Total number of sessions/feeds once the decision has been applied. */
  resultingCount: number;
}

/**
 * Pure connection-limit policy.
 *
 * Kept free of any I/O so the rules can be exhaustively unit-tested and
 * reused by both the ticket scope and the upstream scope.
 */
export function evaluateTicketLimit(
  currentSessions: number,
  maxConnections: number,
  policy: OverflowPolicy,
): LimitDecision {
  const maximum = Math.max(1, maxConnections);

  if (currentSessions < maximum) {
    return {
      action: 'ALLOW',
      allowed: true,
      resultingCount: currentSessions + 1,
    };
  }

  if (policy === OverflowPolicy.EVICT_OLDEST && currentSessions > 0) {
    // The oldest session is closed, then the new one takes its place.
    return {
      action: 'EVICT_OLDEST',
      allowed: true,
      resultingCount: maximum,
      reason: 'Limite du ticket atteinte: la connexion la plus ancienne est fermee.',
    };
  }

  return {
    action: 'REJECT',
    allowed: false,
    resultingCount: currentSessions,
    reason:
      maximum === 1
        ? 'Un seul appareil peut regarder la TV a la fois sur ce ticket.'
        : `Nombre maximal de ${maximum} connexions simultanees atteint pour ce ticket.`,
  };
}

export function evaluateUpstreamLimit(
  currentFeeds: number,
  maxConnections: number,
  policy: OverflowPolicy,
): LimitDecision {
  const maximum = Math.max(1, maxConnections);

  if (currentFeeds < maximum) {
    return {
      action: 'ALLOW',
      allowed: true,
      resultingCount: currentFeeds + 1,
    };
  }

  if (policy === OverflowPolicy.EVICT_OLDEST && currentFeeds > 0) {
    return {
      action: 'EVICT_OLDEST',
      allowed: true,
      resultingCount: maximum,
      reason: 'Limite upstream atteinte: le flux le plus ancien est ferme.',
    };
  }

  return {
    action: 'REJECT',
    allowed: false,
    resultingCount: currentFeeds,
    reason:
      'Le compte source a atteint sa limite de connexions simultanees. Reessayez dans quelques instants.',
  };
}

/**
 * Fan-out decision: several devices watching the same channel share a single
 * upstream connection. Returns true when no new upstream connection is needed.
 *
 * @param feedKey fully qualified key (`providerId:kind:streamId`)
 */
export function sharesUpstreamFeed(
  feedKey: string,
  existingFeeds: Array<{ feedKey: string }>,
): boolean {
  return existingFeeds.some((feed) => feed.feedKey === feedKey);
}
