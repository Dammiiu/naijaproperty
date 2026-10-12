import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException, type ErrorCode } from '@naijaproperty/contracts';
import { Prisma } from '@prisma/client';

/**
 * Single exit point for errors. Guarantees:
 *  - a stable machine-readable `code` the web and mobile clients can branch on
 *  - no stack traces or internal detail in production responses
 *  - every unexpected error is logged with a correlation id
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const requestId = (request.id as string) ?? 'unknown';
    const mapped = this.map(exception, requestId);

    if (mapped.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${mapped.status} ${mapped.code}: ${mapped.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${mapped.status} ${mapped.code}: ${mapped.message}`,
      );
    }

    void reply.status(mapped.status).send({
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        requestId,
      },
    });
  }

  private map(
    exception: unknown,
    requestId: string,
  ): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Array<{ path: string; message: string }>;
  } {
    if (exception instanceof ApiException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message as string | string[] | undefined);

      // Map HTTP semantics onto our own error vocabulary.
      const code: ErrorCode =
        status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 429
                ? 'RATE_LIMITED'
                : status >= 500
                  ? 'INTERNAL_ERROR'
                  : 'VALIDATION_FAILED';

      return {
        status,
        code,
        message: Array.isArray(message)
          ? 'Some fields need attention'
          : (message ?? exception.message),
      };
    }

    // Prisma errors carry useful codes but leaky messages, so we translate.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: 409,
          code: 'CONFLICT',
          message: 'That value is already taken',
        };
      }
      if (exception.code === 'P2025') {
        return { status: 404, code: 'NOT_FOUND', message: 'Not found' };
      }
      if (exception.code === 'P2003') {
        return {
          status: 400,
          code: 'VALIDATION_FAILED',
          message: 'That references a record that does not exist',
        };
      }
      // 23514 is a CHECK violation, which for us means a schema invariant
      // caught something the application layer should have.
      if (exception.code === 'P2010' || exception.code === 'P2004') {
        return {
          status: 409,
          code: 'CONFLICT',
          message: 'That change violates a data rule',
        };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'That request was not understood',
      };
    }

    if (exception instanceof Error && exception.name === 'TimeoutError') {
      return {
        status: 504,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'A service took too long to respond. Try again.',
      };
    }

    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side',
    };
  }
}
