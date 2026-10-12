/**
 * Auth contracts. Phone OTP is a first-class method alongside email/password
 * and Google OAuth, because phone is the actual identity primitive in Nigeria
 * and is what earns the VERIFIED_ID badge.
 */

import { z } from 'zod';
import { emailAddress, nigerianPhone, otpCode } from './primitives.js';

/**
 * Password policy. Argon2id does the heavy lifting; length is what actually
 * defends accounts, so we require 10+ and block the obvious lists.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((p) => /[a-z]/.test(p), 'Include a lowercase letter')
  .refine((p) => /[A-Z]/.test(p), 'Include an uppercase letter')
  .refine((p) => /\d/.test(p), 'Include a number');

export const registerSchema = z.object({
  email: emailAddress,
  password: passwordSchema,
  phone: nigerianPhone.optional(),
  displayName: z.string().trim().min(2).max(80),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms to continue' }),
  }),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailAddress,
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).optional(),
});

export const requestOtpSchema = z.object({
  phone: nigerianPhone,
  /** Set by the client so we can report which channel actually delivered. */
  clientHint: z.enum(['WHATSAPP', 'SMS', 'AUTO']).default('AUTO'),
});
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

export const verifyOtpSchema = z.object({
  phone: nigerianPhone,
  code: otpCode,
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const otpRequestResponseSchema = z.object({
  challengeId: z.string(),
  /** Which channel was used first. SMS may follow if WhatsApp does not deliver. */
  primaryChannel: z.enum(['WHATSAPP', 'SMS']),
  smsFallbackScheduled: z.boolean(),
  expiresInSeconds: z.number().int(),
  resendAvailableInSeconds: z.number().int(),
  /** Set when the user has an existing account and is signing in. */
  mode: z.enum(['REGISTER', 'LOGIN']),
});
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

export const otpVerifyResponseSchema = z.object({
  verified: z.literal(true),
  /** Which channel actually delivered the code. */
  deliveredVia: z.enum(['WHATSAPP', 'SMS']),
  user: z.object({
    id: z.string(),
    email: emailAddress,
    displayName: z.string(),
    phoneVerified: z.boolean(),
    role: z.string(),
    verificationTier: z.string(),
  }),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int(),
});
export type OtpVerifyResponse = z.infer<typeof otpVerifyResponseSchema>;

export const userProfileSchema = z.object({
  id: z.string(),
  email: emailAddress,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['USER', 'AGENT', 'MODERATOR', 'ADMIN', 'SUPERADMIN']),
  verificationTier: z.enum(['NONE', 'PHONE', 'DOCUMENT', 'VERIFIED_AGENT']),
  phoneVerified: z.boolean(),
  createdAt: z.string(),
  twoFactorEnabled: z.boolean(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

/** Safe projection. Never include phone or exact address here. */
export const authUserSchema = z.object({
  id: z.string(),
  email: emailAddress,
  displayName: z.string(),
  role: userProfileSchema.shape.role,
  verificationTier: userProfileSchema.shape.verificationTier,
});
