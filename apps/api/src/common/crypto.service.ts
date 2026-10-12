import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PiiService } from './pii.service.js';
import { getEnv } from '../config/env.js';

/**
 * Password hashing with Argon2id.
 *
 * Parameters are tuned for the target hardware budget. Memory cost is the
 * dominant lever and we set it explicitly rather than relying on library
 * defaults, so the trade-off is visible in review.
 */
@Injectable()
export class PasswordService {
  private static readonly OPTIONS = {
    type: 2, // argon2id
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  async hash(password: string): Promise<string> {
    const argon2 = await import('argon2');
    return argon2.hash(password, PasswordService.OPTIONS);
  }

  async verify(digest: string, password: string): Promise<boolean> {
    try {
      const argon2 = await import('argon2');
      // Options are only meaningful when hashing; verification takes them from
      // the digest itself, so we deliberately do not pass them here.
      return await argon2.verify(digest, password);
    } catch {
      return false;
    }
  }

  /**
   * Dummy verification for unknown-email logins. Without this, response time
   * reveals whether an email is registered.
   */
  private static readonly DUMMY_HASH =
    '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$8J8kQ7Yq3nR2xV5pL9wZ1sB4cD6eF0gH2iJ4kL6mN8oP0q';

  async burnTiming(password: string): Promise<void> {
    await this.verify(PasswordService.DUMMY_HASH, password);
  }
}

/**
 * OTP code generation and hashing. Codes are 6 digits, matching Termii's
 * 4-6 numeric constraint, and are generated with a CSPRNG.
 */
@Injectable()
export class OtpService {
  constructor(private readonly pii: PiiService) {}

  generate(): string {
    // randomInt is rejection-sampled, so no modulo bias.
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  hash(code: string): string {
    return this.pii.hashOtp(code);
  }

  verify(code: string, hash: string): boolean {
    return this.pii.verifyOtpHash(code, hash);
  }

  ttlSeconds(): number {
    return getEnv().OTP_TTL_SECONDS;
  }

  maxAttempts(): number {
    return getEnv().OTP_MAX_ATTEMPTS;
  }
}
