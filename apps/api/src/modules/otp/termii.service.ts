import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.js';

/**
 * Termii client.
 *
 * Two endpoints matter here, both documented at developers.termii.com:
 *   POST {BASE_URL}/api/sms/send          with channel=whatsapp_otp for WhatsApp
 *                                          channel=generic for SMS
 *   POST {BASE_URL}/api/sms/otp/verify    with pin_id + pin
 *
 * Note that the WhatsApp OTP endpoint is not enabled on every account by
 * default; it must be activated with Termii support. `isWhatsappEnabled()`
 * lets the API degrade to SMS-only cleanly when it is not.
 */

interface TermiiSendResponse {
  code?: string;
  message?: string;
  message_id?: string;
  message_id_str?: string;
  balance?: number;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  balance?: number;
  error?: string;
}

export interface DeliveryReport {
  messageId: string;
  status: string;
  channel?: string;
  receiver?: string;
  raw: unknown;
}

@Injectable()
export class TermiiService {
  private readonly logger = new Logger(TermiiService.name);

  /**
   * Sends an OTP over the WhatsApp channel. `from` must be a connected device
   * name, not an alphanumeric sender ID.
   */
  async sendWhatsappOtp(to: string, otp: string, from: string): Promise<SendResult> {
    return this.post('/api/sms/send', {
      to,
      from,
      sms: otp,
      type: 'plain',
      channel: 'whatsapp_otp',
    });
  }

  /** Sends an OTP over the SMS channel. `from` must be 3-11 alphanumeric chars. */
  async sendSmsOtp(to: string, otp: string, from: string): Promise<SendResult> {
    return this.post('/api/sms/send', {
      to,
      from,
      sms: otp,
      type: 'plain',
      channel: 'generic',
    });
  }

  /**
   * Server-side verification via Termii. We verify locally against our own HMAC
   * as the source of truth, so this is optional and used only as a secondary
   * check where a pin_id is available.
   */
  async verifyToken(pinId: string, pin: string): Promise<{ verified: boolean; msisdn?: string }> {
    const res = await this.post('/api/sms/otp/verify', { pin_id: pinId, pin });
    if (!res.ok) return { verified: false };
    const body = res as SendResult & { verified?: string; msisdn?: string };
    return {
      verified: String(body.verified ?? '').toLowerCase() === 'true',
      msisdn: body.msisdn,
    };
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<SendResult> {
    const env = getEnv();

    if (!env.TERMII_API_KEY || !env.TERMII_BASE_URL) {
      this.logger.error('Termii is not configured; set TERMII_API_KEY and TERMII_BASE_URL');
      return { ok: false, error: 'termii_not_configured' };
    }

    const url = `${env.TERMII_BASE_URL.replace(/\/$/, '')}${path}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.TERMII_API_KEY, ...payload }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const text = await response.text();
      let parsed: TermiiSendResponse;
      try {
        parsed = JSON.parse(text) as TermiiSendResponse;
      } catch {
        this.logger.error(`Termii non-JSON response (${response.status}): ${text.slice(0, 200)}`);
        return { ok: false, error: `http_${response.status}` };
      }

      if (!response.ok) {
        // Termii returns a useful business error in the body even on a non-2xx:
        // SENDER_ID_NOT_APPROVED, insufficient balance, invalid recipient.
        // Passing it through verbatim is what makes these diagnosable without
        // reading provider documentation.
        const detail = parsed.message ?? text.slice(0, 300);
        this.logger.warn(`Termii HTTP ${response.status}: ${detail}`);

        if (typeof detail === 'string' && detail.includes('SENDER_ID_NOT_APPROVED')) {
          this.logger.error(
            `Termii sender ID "${String(payload.from)}" is not registered for this ` +
              'workspace. Register it in the Termii dashboard and set TERMII_SMS_FROM to match.',
          );
        }

        return { ok: false, error: detail };
      }

      // Termii signals success with code "ok"; anything else is a soft failure
      // such as insufficient balance.
      const ok = parsed.code === 'ok';
      if (!ok) {
        this.logger.warn(`Termii rejected send: ${parsed.message ?? 'unknown'}`);
      }

      return {
        ok,
        messageId: parsed.message_id_str ?? parsed.message_id,
        balance: parsed.balance,
        error: ok ? undefined : (parsed.message ?? 'rejected'),
      };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Termii request failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Verifies an inbound webhook.
   *
   * Termii signs each event with HMAC SHA512 over the raw request body and sends
   * it as `X-Termii-Signature`. Verifying the raw body (not the parsed JSON) is
   * essential; re-serialising would change the bytes and break the signature.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = getEnv().TERMII_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('TERMII_WEBHOOK_SECRET is not set; rejecting webhook');
      return false;
    }
    if (!signature) return false;

    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const provided = signature.trim().toLowerCase();

    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }

  /**
   * Parses a delivery report. Termii's documented status vocabulary:
   * "Delivered", "Message Sent", "Message Failed", "Expired", "Rejected",
   * "DND Active on Phone Number", "Received".
   */
  parseDeliveryReport(rawBody: Buffer | string): DeliveryReport | null {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Device status events share the endpoint but carry no message id.
    const type = String(payload.type ?? '');
    if (type === 'device_status') return null;

    const messageId = String(payload.message_id ?? payload.id ?? '');
    if (!messageId) return null;

    return {
      messageId,
      status: String(payload.status ?? ''),
      channel: payload.channel ? String(payload.channel) : undefined,
      receiver: payload.receiver ? String(payload.receiver) : undefined,
      raw: payload,
    };
  }

  isWhatsappConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.TERMII_API_KEY && env.TERMII_BASE_URL && env.TERMII_WHATSAPP_FROM);
  }
}
