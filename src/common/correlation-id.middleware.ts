import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export type CorrelatedRequest = Request & { correlationId?: string };

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: CorrelatedRequest, res: Response, next: NextFunction): void {
    const header = req.headers['x-correlation-id'];
    const incoming = Array.isArray(header) ? header[0] : header;
    const value =
      typeof incoming === 'string' && incoming.trim().length > 0
        ? incoming.trim()
        : randomUUID();
    req.correlationId = value;
    res.setHeader('x-correlation-id', value);
    next();
  }
}
