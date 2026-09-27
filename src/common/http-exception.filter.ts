import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

interface ErrorBody {
  statusCode: number;
  message: string;
  details?: unknown;
  requestId?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest();
    const response = host.switchToHttp().getResponse();
    const body = this.toBody(exception);
    if (request?.id) body.requestId = request.id;
    if (body.statusCode >= 500) {
      // strip the query string so a token or secret passed as a query param never reaches logs
      const path = (request.originalUrl ?? request.url).split('?')[0];
      this.logger.error(`${request.method} ${path} → ${body.statusCode}`, exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (!(exception instanceof HttpException)) {
      return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    }
    const statusCode = exception.getStatus();
    const raw = exception.getResponse();

    if (typeof raw === 'string') return { statusCode, message: raw };

    const obj = raw as { message?: unknown; details?: unknown };
    if (Array.isArray(obj.message)) {
      return { statusCode, message: 'Validation failed', details: obj.message };
    }
    const body: ErrorBody = { statusCode, message: typeof obj.message === 'string' ? obj.message : exception.message };
    if (obj.details !== undefined) body.details = obj.details;
    return body;
  }
}
