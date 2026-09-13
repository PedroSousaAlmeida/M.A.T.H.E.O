import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { PinoLoggerService } from './logger/pino-logger.service';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLoggerService) {}

  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && VALID_ID.test(candidate) ? candidate : randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
    RequestContext.run({ requestId, ip: req.ip, userAgent }, () => {
      const started = Date.now();
      res.on('finish', () => {
        // strip the query string so a token or secret passed as a query param never reaches logs
        const path = (req.originalUrl ?? req.url).split('?')[0];
        const fields = { method: req.method, path, statusCode: res.statusCode, durationMs: Date.now() - started };
        this.logger.access(fields, path.endsWith('/health') ? 'debug' : 'info');
      });
      next();
    });
  }
}
