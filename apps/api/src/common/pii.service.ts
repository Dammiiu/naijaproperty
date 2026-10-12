import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getEnv } from '../config/env.js';

/**
 * PII protection.
 *
 * Phone numbers and exact addresses are the two fields that make this product
 * worth using and worth stealing, so they get envelope encryption at rest and a
 * blind index for lookups. This service is the only place plaintext exists,
 * and `RevealService` is the only caller that decrypts for a request.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

@Injectable()
export class PiiService {
  private readonly key: Buffer;

  constructor() {
    this.key = this.deriveKey(getEnv().PII_ENCRYPTION_KEY);
  }

  /**
   * Derives a 32-byte key. Accepts raw hex/base64 of sufficient length or a
   * passphrase, which is hashed with a fixed salt so the operator can use a
   * generated random string from the env template.
   */
  private deriveKey(raw: string): Buffer {
    const trimmed = raw.trim();
    if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
    return createHash('sha256').update(`naijaproperty:pii:v1:${trimmed}`).digest();
  }

  /** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Malformed PII envelope');
    }
    const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Deterministic keyed index. Lets us enforce uniqueness and look up a phone
   * number without decrypting, so the blind index cannot be brute-forced even
   * though the key space is only 10^10 valid Nigerian mobile numbers.
   */
  blindIndex(value: string): string {
    return createHmac('sha256', getEnv().OTP_PEPPER)
      .update(`pii-idx:${value}`)
      .digest('base64url');
  }

  /** Keyed hash of an OTP code. Fast is acceptable here: codes are 6 digits. */
  hashOtp(code: string): string {
    return createHmac('sha256', getEnv().OTP_PEPPER)
      .update(`otp:${code}`)
      .digest('base64url');
  }

  verifyOtpHash(code: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashOtp(code));
    const expected = Buffer.from(expectedHash);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  /** Normalises Nigerian phone input to E.164 digits before encryption. */
  static normalisePhone(input: string): string {
    const digits = input.replace(/[\s()\-.]/g, '');
    if (digits.startsWith('+234')) return digits.slice(1);
    if (digits.startsWith('234')) return digits;
    if (digits.startsWith('0')) return `234${digits.slice(1)}`;
    if (digits.startsWith('80') || digits.startsWith('81') || digits.startsWith('70'))
      return `234${digits}`;
    return digits;
  }

  /** Hashed IP: retains abuse-detection signal without retaining raw IPs. */
  hashIp(ip: string | undefined): string | undefined {
    if (!ip) return undefined;
    return createHmac('sha256', getEnv().OTP_PEPPER)
      .update(`ip:${ip}`)
      .digest('base64url')
      .slice(0, 22);
  }

  /** wa.me deep link so a revealed contact opens straight into a chat. */
  whatsappUrl(phoneE164: string, text?: string): string {
    const base = `https://wa.me/${phoneE164}`;
    return text ? `${base}?text=${encodeURIComponent(text)}` : base;
  }
}
