import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorDetail {
  field?: string;
  message: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details: ErrorDetail[];
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';
    let details: ErrorDetail[] = [];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        code = this.statusToCode(status);
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        // Handle structured envelope: { error: { code, message, details } }
        const nested = resp['error'];
        if (nested && typeof nested === 'object') {
          const err = nested as Record<string, unknown>;
          if (typeof err['code'] === 'string') code = err['code'];
          if (typeof err['message'] === 'string') message = err['message'];
          if (Array.isArray(err['details'])) details = err['details'] as ErrorDetail[];
        } else {
          // Fallback: flat shape { code, message } or NestJS default { message, statusCode }
          if (typeof resp['code'] === 'string') code = resp['code'];
          if (typeof resp['message'] === 'string') {
            message = resp['message'];
          } else if (Array.isArray(resp['message'])) {
            details = (resp['message'] as string[]).map((m) => ({ message: m }));
            message = 'Validation failed';
            code = 'VALIDATION_ERROR';
          }
          if (code === 'INTERNAL_SERVER_ERROR') code = this.statusToCode(status);
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    }

    const errorResponse: ErrorResponse = {
      error: {
        code,
        message,
        details,
      },
    };

    response.status(status).json(errorResponse);
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMIT_EXCEEDED',
      500: 'INTERNAL_SERVER_ERROR',
    };
    return map[status] ?? 'INTERNAL_SERVER_ERROR';
  }
}
