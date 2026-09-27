import { Injectable, LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { RequestContext } from '../request-context';

export interface PinoLoggerOptions {
  level: string;
  pretty: boolean;
}

/** Nest LoggerService over pino. Every line carries requestId/userId from RequestContext when inside a request. */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: Logger;

  constructor(
    options: PinoLoggerOptions,
    stream?: DestinationStream,
    prettyFactory: () => DestinationStream = () => require('pino-pretty')({ colorize: true, translateTime: 'SYS:HH:MM:ss' }),
  ) {
    let destination = stream;
    let prettyFailed = false;
    if (!destination && options.pretty) {
      try {
        destination = prettyFactory();
      } catch {
        prettyFailed = true;
      }
    }
    this.logger = destination ? pino({ level: options.level }, destination) : pino({ level: options.level });
    if (prettyFailed) this.logger.warn('pino-pretty not installed; logging JSON');
  }

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info(this.fields(optional), String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    // Nest passes (message, stack?, context?)
    const [stack, context] = optional.length === 2 ? optional : [undefined, optional[0]];
    this.logger.error({ ...this.fields([context]), ...(typeof stack === 'string' ? { stack } : {}) }, String(message));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn(this.fields(optional), String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug(this.fields(optional), String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.trace(this.fields(optional), String(message));
  }

  /** One structured line per HTTP request. Never includes the query string (see RequestIdMiddleware). */
  access(fields: { method: string; path: string; statusCode: number; durationMs: number }, level: 'info' | 'debug' = 'info') {
    this.logger[level]({ ...this.fields([]), ...fields, context: 'HTTP' }, 'request');
  }

  private fields(optional: unknown[]): Record<string, unknown> {
    const ctx = RequestContext.get();
    const context = typeof optional[optional.length - 1] === 'string' ? optional[optional.length - 1] : undefined;
    return { ...(ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {}), ...(context ? { context } : {}) };
  }
}
