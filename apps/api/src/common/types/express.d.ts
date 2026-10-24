import { Ticket } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Ticket authenticated by the TicketAuthGuard (never serialised). */
      ticket?: Ticket;
      /** Correlation id set by the RequestContextMiddleware. */
      id?: string;
      /** Real client IP (behind nginx). */
      clientIp?: string;
    }
  }
}

export {};
