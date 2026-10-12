/**
 * Primitive scalars shared across every contract module.
 */

import { z } from 'zod';

/** Nigerian mobile numbers in E.164 form: +2348012345678 -> 2348012345678 */
export const NIGERIAN_MOBILE_RE = /^234[789]\d{9}$/;

export const cuid = z.string().min(20).max(40);

export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

/**
 * Accepts Nigerian input formats and normalises to E.164 digits.
 * Permissive on input (users type spaces, +234, leading 0) strict on output.
 */
export const nigerianPhone = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const digits = raw.replace(/[\s()\-.]/g, '');
    let e164 = digits;

    if (digits.startsWith('+234')) e164 = digits.slice(1);
    else if (digits.startsWith('234')) e164 = digits;
    else if (digits.startsWith('0')) e164 = `234${digits.slice(1)}`;
    else if (digits.startsWith('80') || digits.startsWith('81') || digits.startsWith('70'))
      e164 = `234${digits}`;
    else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid Nigerian phone number',
      });
      return z.NEVER;
    }

    if (!NIGERIAN_MOBILE_RE.test(e164)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid Nigerian phone number',
      });
      return z.NEVER;
    }
    return e164;
  });

/** Numeric OTP. Termii accepts 4-6 characters; we issue 6. */
export const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const nairaAmount = z.coerce
  .number()
  .int('Price must be a whole number')
  .nonnegative('Price cannot be negative')
  .max(10_000_000_000_000, 'Price exceeds the maximum allowed');

export const isoDateTime = z.string().datetime({ offset: true });

export const paginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
