/**
 * Shared error envelope. Every non-2xx API response uses this shape so the web
 * and mobile clients can branch on `code` rather than parse messages.
 */

import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PHONE_ALREADY_REGISTERED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_ATTEMPTS_EXCEEDED',
  'LISTING_NOT_APPROVED',
  'QUOTA_EXCEEDED',
  'MEDIA_NOT_READY',
  'MEDIA_QUOTA_EXCEEDED',
  'PAYMENT_REQUIRED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** Field-level messages for VALIDATION_FAILED. */
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiException';
  }

  static notFound(message = 'Not found'): ApiException {
    return new ApiException('NOT_FOUND', message, 404);
  }

  static unauthenticated(message = 'Sign in to continue'): ApiException {
    return new ApiException('UNAUTHENTICATED', message, 401);
  }

  static forbidden(message = 'You do not have access to this'): ApiException {
    return new ApiException('FORBIDDEN', message, 403);
  }

  static conflict(code: ErrorCode, message: string): ApiException {
    return new ApiException(code, message, 409);
  }

  static validation(
    details: Array<{ path: string; message: string }>,
    message = 'Check the highlighted fields',
  ): ApiException {
    return new ApiException('VALIDATION_FAILED', message, 400, details);
  }

  static rateLimited(message: string, retryAfterSeconds?: number): ApiException {
    const e = new ApiException('RATE_LIMITED', message, 429);
    if (retryAfterSeconds !== undefined) {
      (e as ApiException & { retryAfterSeconds?: number }).retryAfterSeconds =
        retryAfterSeconds;
    }
    return e;
  }

  static internal(message = 'Something went wrong'): ApiException {
    return new ApiException('INTERNAL_ERROR', message, 500);
  }
}
