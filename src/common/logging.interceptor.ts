import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PinoLoggerService } from './logger/pino-logger.service';

/** One access-log line per request. /health is logged at debug to keep probes out of the main stream. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const started = Date.now();
    const write = (statusCode: number) => {
      const line = `${request.method} ${request.originalUrl ?? request.url} ${statusCode} ${Date.now() - started}ms`;
      if (String(request.originalUrl ?? request.url).endsWith('/health')) this.logger.debug(line, 'HTTP');
      else this.logger.log(line, 'HTTP');
    };
    return next.handle().pipe(
      tap({
        next: () => write(http.getResponse().statusCode),
        error: (error: unknown) => write(typeof (error as { getStatus?: () => number }).getStatus === 'function' ? (error as { getStatus: () => number }).getStatus() : 500),
      }),
    );
  }
}
