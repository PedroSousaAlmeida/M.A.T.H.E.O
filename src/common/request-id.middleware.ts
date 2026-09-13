import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && VALID_ID.test(candidate) ? candidate : randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    RequestContext.run({ requestId }, () => next());
  }
}
