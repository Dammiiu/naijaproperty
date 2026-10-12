import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OtpChannel, OtpStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { OtpService } from '../../common/crypto.service.js';
import { TermiiService } from './termii.service.js';
import { getEnv } from '../../config/env.js';

/**
 * Phone OTP over Termii, WhatsApp-first with a cost-aware SMS fallback.
 *
 * Flow:
 *   1. Generate a 6-digit code, store only its HMAC.
 *   2. Send over the WhatsApp channel (`whatsapp_otp`) — cheaper than SMS and
 *      read far more often in Nigeria.
 *   3. Arm `smsFallbackDueAt = now + OTP_SMS_FALLBACK_DELAY_SECONDS`.
 *   4. Termii posts delivery reports to our webhook. A `Delivered` status
 *      clears the fallback timer.
 *   5. If the timer fires with no delivery, send the same code over SMS.
 *
 * The property that matters: SMS is only spent when WhatsApp genuinely failed.
 * A WhatsApp delivery report arriving late is harmless, because the challenge
 * is already verified or the SMS is a no-op the user ignores.
 */

interface PendingFallback {
  challengeId: string;
  phoneE164: string;
  code: string;
}

@Injectable()
export class OtpOrchestrator implements OnModuleInit {
  private readonly logger = new Logger(OtpOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly otp: OtpService,
    private readonly termii: TermiiService,
  ) {}

  onModuleInit(): void {
    this.logger.log('OTP orchestrator ready');
  }

  /**
   * Issues a challenge and sends the primary (WhatsApp) message.
   * Returns metadata the client needs to render the resend countdown.
   */
  async issue(input: {
    phone: string;
    userId?: string;
    ip?: string;
    preferSms?: boolean;
  }): Promise<{
    challengeId: string;
    primaryChannel: OtpChannel;
    smsFallbackScheduled: boolean;
    expiresInSeconds: number;
  }> {
    const phoneE164 = PiiService.normalisePhone(input.phone);
    const phoneIdx = this.pii.blindIndex(phoneE164);

    // Invalidate any outstanding challenge for this number so only the newest
    // code is ever accepted. Without this, a delayed SMS could arrive after a
    // user has already used an earlier code.
    await this.prisma.otpChallenge.updateMany({
      where: {
        phoneIdx,
        status: { in: [OtpStatus.PENDING, OtpStatus.SENT, OtpStatus.DELIVERED] },
      },
      data: { status: OtpStatus.EXPIRED },
    });

    const code = this.otp.generate();
    const ttl = this.otp.ttlSeconds();
    const now = new Date();
    const fallbackDelay = getEnv().OTP_SMS_FALLBACK_DELAY_SECONDS;

    const useSmsPrimary = input.preferSms === true;
    const primaryChannel: OtpChannel = useSmsPrimary ? OtpChannel.SMS : OtpChannel.WHATSAPP;

    const challenge = await this.prisma.otpChallenge.create({
      data: {
        phoneIdx,
        userId: input.userId ?? null,
        codeHash: this.otp.hash(code),
        primaryChannel,
        status: OtpStatus.PENDING,
        maxAttempts: this.otp.maxAttempts(),
        expiresAt: new Date(now.getTime() + ttl * 1000),
        ipHash: this.pii.hashIp(input.ip),
        // SMS fallback only makes sense when WhatsApp was the primary route.
        smsFallbackDueAt:
          primaryChannel === OtpChannel.WHATSAPP
            ? new Date(now.getTime() + fallbackDelay * 1000)
            : null,
      },
    });

    // Retain plaintext in memory (never in the DB) so the SMS fallback can be
    // composed, and cache the number so anonymous challenges remain routable.
    this.setPlaintext(challenge.id, code);
    this.setPhoneCache(phoneIdx, phoneE164);

    const sent = await this.send(challenge.id, phoneE164, code, primaryChannel);

    return {
      challengeId: challenge.id,
      primaryChannel,
      smsFallbackScheduled: primaryChannel === OtpChannel.WHATSAPP && sent.ok,
      expiresInSeconds: ttl,
    };
  }

  /** Sends on one channel and records the Termii message id for webhook matching. */
  private async send(
    challengeId: string,
    phoneE164: string,
    code: string,
    channel: OtpChannel,
  ): Promise<{ ok: boolean; messageId?: string }> {
    const env = getEnv();

    try {
      const res =
        channel === OtpChannel.WHATSAPP
          ? await this.termii.sendWhatsappOtp(phoneE164, code, env.TERMII_WHATSAPP_FROM)
          : await this.termii.sendSmsOtp(phoneE164, code, env.TERMII_SMS_FROM);

      if (!res.ok) {
        this.logger.warn(
          `OTP send failed on ${channel} for challenge ${challengeId}: ${res.error ?? 'unknown'}`,
        );
        await this.prisma.otpChallenge.update({
          where: { id: challengeId },
          data: {
            status: OtpStatus.FAILED,
            // If WhatsApp could not be dispatched at all, the fallback timer is
            // useless, so escalate straight to SMS.
            smsFallbackDueAt:
              channel === OtpChannel.WHATSAPP ? new Date(Date.now() + 1500) : null,
          },
        });
        return { ok: false };
      }

      await this.prisma.otpChallenge.update({
        where: { id: challengeId },
        data: {
          status: OtpStatus.SENT,
          ...(channel === OtpChannel.WHATSAPP
            ? { whatsappMessageId: res.messageId ?? null }
            : { smsMessageId: res.messageId ?? null }),
          // SMS went out, so the fallback is no longer pending.
          ...(channel === OtpChannel.SMS ? { smsFallbackSentAt: new Date() } : {}),
        },
      });

      return { ok: true, messageId: res.messageId };
    } catch (err) {
      this.logger.error(`OTP send threw on ${channel}: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  /**
   * Verifies a submitted code.
   * Returns the delivered channel so the client can tell the user where to look.
   */
  async verify(input: {
    phone: string;
    code: string;
    ip?: string;
  }): Promise<{
    ok: true;
    userId: string | null;
    phoneE164: string;
    deliveredVia: OtpChannel;
  } | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'LOCKED' | 'NOT_FOUND' }> {
    const phoneE164 = PiiService.normalisePhone(input.phone);
    const phoneIdx = this.pii.blindIndex(phoneE164);

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phoneIdx },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) return { ok: false, reason: 'NOT_FOUND' };

    if (challenge.status === OtpStatus.VERIFIED) return { ok: false, reason: 'INVALID' };
    if (challenge.status === OtpStatus.ATTEMPTS_EXCEEDED) return { ok: false, reason: 'LOCKED' };
    if (challenge.status === OtpStatus.EXPIRED || challenge.expiresAt < new Date())
      return { ok: false, reason: 'EXPIRED' };

    if (!this.otp.verify(input.code, challenge.codeHash)) {
      const attempts = challenge.attempts + 1;
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          attempts,
          status:
            attempts >= challenge.maxAttempts ? OtpStatus.ATTEMPTS_EXCEEDED : challenge.status,
        },
      });
      return { ok: false, reason: attempts >= challenge.maxAttempts ? 'LOCKED' : 'INVALID' };
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { status: OtpStatus.VERIFIED, verifiedAt: new Date() },
    });

    const deliveredVia = challenge.whatsappDeliveredAt
      ? OtpChannel.WHATSAPP
      : challenge.smsMessageId
        ? OtpChannel.SMS
        : challenge.primaryChannel;

    return { ok: true, userId: challenge.userId, phoneE164, deliveredVia };
  }

  /**
   * Applies a Termii delivery report.
   * Returns true when this event means "the user got it".
   */
  async applyDeliveryReport(input: {
    messageId: string;
    status: string;
  }): Promise<void> {
    const delivered = ['delivered', 'message delivered to handset'].includes(
      input.status.trim().toLowerCase(),
    );
    const failed = [
      'message failed',
      'expired',
      'rejected',
      'dnd active on phone number',
    ].includes(input.status.trim().toLowerCase());

    if (!delivered && !failed) return;

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        OR: [
          { whatsappMessageId: input.messageId },
          { smsMessageId: input.messageId },
        ],
      },
    });

    if (!challenge) {
      this.logger.debug(`No OTP challenge for Termii message ${input.messageId}`);
      return;
    }

    if (delivered) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          status:
            challenge.status === OtpStatus.VERIFIED
              ? OtpStatus.VERIFIED
              : OtpStatus.DELIVERED,
          whatsappDeliveredAt:
            challenge.whatsappMessageId === input.messageId
              ? (challenge.whatsappDeliveredAt ?? new Date())
              : challenge.whatsappDeliveredAt,
          // Delivery clears the fallback timer. This is the whole cost saving.
          smsFallbackDueAt: null,
        },
      });
      this.logger.debug(`OTP ${challenge.id} delivered via ${input.status}`);
      return;
    }

    // A failure report means we should not wait for the timer any longer.
    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { smsFallbackDueAt: new Date() },
    });
  }

  /**
   * Fallback sweep. Runs every 5 seconds and promotes any WhatsApp challenge
   * whose timer has fired into an SMS send.
   */
  @Cron('*/5 * * * * *')
  async sweepSmsFallback(): Promise<{ swept: number; sent: number }> {
    const now = new Date();

    // The phone number is not stored on the challenge (only its blind index) and
    // neither is the plaintext code (only an HMAC), so a fallback send depends on
    // short-lived in-memory state. Both are documented limits of single-instance
    // Phase 0 operation; see docs/otp-whatsapp-fallback.md.
    const candidates = await this.prisma.otpChallenge.findMany({
      where: {
        status: { in: [OtpStatus.SENT, OtpStatus.PENDING] },
        primaryChannel: OtpChannel.WHATSAPP,
        smsFallbackDueAt: { lte: now },
        smsFallbackSentAt: null,
        smsMessageId: null,
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        phoneIdx: true,
        userId: true,
      },
      take: 100,
    });

    const due: PendingFallback[] = [];

    for (const candidate of candidates) {
      const code = this.plaintextCache.get(candidate.id);
      const phoneE164 = await this.resolvePhone(candidate.phoneIdx, candidate.userId);

      if (!code || !phoneE164) {
        // Cannot reconstruct the SMS. Expire rather than retry, so the client is
        // prompted for a fresh code instead of waiting on a message that will
        // never arrive.
        this.logger.debug(`Challenge ${candidate.id} missing code or phone; expiring`);
        await this.prisma.otpChallenge.update({
          where: { id: candidate.id },
          data: { status: OtpStatus.EXPIRED },
        });
        this.plaintextCache.delete(candidate.id);
        continue;
      }

      due.push({ challengeId: candidate.id, phoneE164, code });
    }

    let sent = 0;
    for (const item of due) {
      const result = await this.send(item.challengeId, item.phoneE164, item.code, OtpChannel.SMS);
      if (result.ok) {
        sent += 1;
        this.plaintextCache.delete(item.challengeId);
      }
    }

    if (due.length) this.logger.log(`SMS fallback sweep: ${sent}/${due.length} sent`);
    return { swept: due.length, sent };
  }

  /**
   * Short-lived in-memory map of challenge id -> plaintext code.
   *
   * We persist only the HMAC, which is the right long-term storage decision but
   * means a fallback SMS cannot be composed after the fact. The plaintext is
   * therefore held in memory for the lifetime of the challenge only, and
   * dropped as soon as the challenge is delivered, verified, or expired.
   *
   * In a multi-instance deployment this map is per-instance, so an SMS fallback
   * would only be sent by the instance that issued the challenge. Phase 0
   * runs a single API process; scaling to multiple instances requires moving
   * this to a short-TTL Redis entry, which is noted in the deployment docs.
   */
  private plaintextCache = new Map<string, string>();

  setPlaintext(challengeId: string, code: string): void {
    this.plaintextCache.set(challengeId, code);
    const ttl = this.otp.ttlSeconds() * 1000;
    setTimeout(() => this.plaintextCache.delete(challengeId), ttl).unref();
  }

  /**
   * Recovers the phone number for a fallback send. Prefers the encrypted value
   * on the user record; anonymous (pre-registration) challenges have no user,
   * so we hold the number in a short-lived map keyed by blind index.
   */
  private async resolvePhone(
    phoneIdx: string,
    userId: string | null,
  ): Promise<string | null> {
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phoneEnc: true },
      });
      if (user?.phoneEnc) {
        try {
          return this.pii.decrypt(user.phoneEnc);
        } catch {
          return null;
        }
      }
    }
    return this.phoneCache.get(phoneIdx) ?? null;
  }

  private phoneCache = new Map<string, string>();

  setPhoneCache(phoneIdx: string, phoneE164: string): void {
    this.phoneCache.set(phoneIdx, phoneE164);
    const ttl = this.otp.ttlSeconds() * 1000;
    setTimeout(() => this.phoneCache.delete(phoneIdx), ttl).unref();
  }

  /**
   * Housekeeping: expire stale challenges and drop resolved plaintext.
   * @Cron is separate from the sweep so a failure here cannot block fallback.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireStale(): Promise<number> {
    const result = await this.prisma.otpChallenge.updateMany({
      where: {
        status: { in: [OtpStatus.PENDING, OtpStatus.SENT, OtpStatus.DELIVERED] },
        expiresAt: { lt: new Date() },
      },
      data: { status: OtpStatus.EXPIRED },
    });
    if (result.count) this.logger.log(`Expired ${result.count} stale OTP challenges`);
    return result.count;
  }
}
