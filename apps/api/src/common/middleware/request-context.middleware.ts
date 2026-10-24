import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Attaches a correlation id to every request (propagated to logs and to the
 * error payload) and applies a few hardening headers.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    req.id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.removeHeader('X-Powered-By');
    next();
  }
}
