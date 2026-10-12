import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Throttle } from '@nestjs/throttler';
import {
  ApiException,
  otpRequestResponseSchema,
  otpVerifyResponseSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from '@naijaproperty/contracts';
import { OtpOrchestrator } from './otp-orchestrator.service.js';
import { TermiiService } from './termii.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { AuthService } from '../auth/auth.service.js';
import { getEnv } from '../../config/env.js';

@ApiTags('auth')
@Controller('auth')
export class OtpController {
  constructor(
    private readonly otp: OtpOrchestrator,
    private readonly termii: TermiiService,
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Requests an OTP. WhatsApp is tried first; SMS is reserved as a fallback for
   * when no delivery webhook arrives inside the configured window.
   */
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a phone OTP (WhatsApp first, SMS fallback)' })
  async request(
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<unknown> {
    const parsed = requestOtpSchema.safeParse(rawBody);
    if (!parsed.success) throw ApiException.validation(zodIssues(parsed.error));

    const env = getEnv();
    const phone = parsed.data.phone;
    const phoneIdx = this.pii.blindIndex(phone);

    // Registration vs sign-in mode, so the client can render the right screen.
    const existing = await this.prisma.user.findUnique({
      where: { phoneIdx },
      select: { id: true },
    });

    const useSmsPrimary =
      parsed.data.clientHint === 'SMS' || !this.termii.isWhatsappConfigured();

    const result = await this.otp.issue({
      phone,
      userId: existing?.id,
      ip: req.ip,
      preferSms: useSmsPrimary,
    });

    const resendAfter = env.OTP_SMS_FALLBACK_DELAY_SECONDS;

    return otpRequestResponseSchema.parse({
      challengeId: result.challengeId,
      primaryChannel: result.primaryChannel,
      smsFallbackScheduled: result.smsFallbackScheduled,
      expiresInSeconds: result.expiresInSeconds,
      // Do not advertise the fallback delay as the resend delay; use a fixed
      // cooldown so clients cannot hammer the provider.
      resendAvailableInSeconds: 60,
      mode: existing ? 'LOGIN' : 'REGISTER',
    });
  }

  /** Verifies the submitted code and issues a session. */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a phone OTP' })
  async verify(@Body() rawBody: unknown, @Req() req: FastifyRequest): Promise<unknown> {
    const parsed = verifyOtpSchema.safeParse(rawBody);
    if (!parsed.success) throw ApiException.validation(zodIssues(parsed.error));

    const result = await this.otp.verify({
      phone: parsed.data.phone,
      code: parsed.data.code,
      ip: req.ip,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'EXPIRED':
          throw new ApiException('OTP_EXPIRED', 'That code has expired. Request a new one.', 400);
        case 'LOCKED':
          throw new ApiException(
            'OTP_ATTEMPTS_EXCEEDED',
            'Too many incorrect attempts. Request a new code.',
            429,
          );
        case 'NOT_FOUND':
          throw new ApiException('OTP_INVALID', 'That code is not valid.', 400);
        default:
          throw new ApiException('OTP_INVALID', 'That code is not valid.', 400);
      }
    }

    // A verified phone is the basis for the VERIFIED_ID badge, so this is where
    // the tier is granted and the encrypted number is persisted.
    const session = await this.auth.upsertFromVerifiedPhone({
      phoneE164: result.phoneE164,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return otpVerifyResponseSchema.parse({
      verified: true,
      deliveredVia: result.deliveredVia,
      user: session.user,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresInSeconds: session.expiresInSeconds,
    });
  }

  /**
   * Termii delivery webhook.
   *
   * The raw body is needed for signature verification, so the handler is
   * excluded from the JSON body parser and reads the stream directly.
   */
  @Post('termii/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async termiiWebhook(
    @Req() req: FastifyRequest,
    @Headers('x-termii-signature') signature: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const body = raw ?? Buffer.from(JSON.stringify(req.body ?? {}));

    if (!this.termii.verifyWebhookSignature(body, signature)) {
      this.otp['logger']?.error?.('Rejected Termii webhook with invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const report = this.termii.parseDeliveryReport(body);
    if (!report) {
      // Device status events are not errors; acknowledge them.
      return reply.code(200).send({ received: true, ignored: true });
    }

    // Idempotency: a replayed delivery report must not double-apply.
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: 'TERMII',
          externalId: `${report.messageId}:${report.status}`,
          eventType: 'delivery_report',
          payload: report.raw as object,
          signatureValid: true,
          processedAt: new Date(),
        },
      });
    } catch {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    await this.otp.applyDeliveryReport({
      messageId: report.messageId,
      status: report.status,
    });

    return reply.code(200).send({ received: true });
  }

  /** Provider health, so the client can explain a channel before attempting. */
  @Get('otp/channels')
  @ApiOperation({ summary: 'Which OTP channels are currently available' })
  channels(): { whatsapp: boolean; sms: boolean; fallbackDelaySeconds: number } {
    const env = getEnv();
    return {
      whatsapp: this.termii.isWhatsappConfigured(),
      sms: Boolean(env.TERMII_API_KEY && env.TERMII_BASE_URL),
      fallbackDelaySeconds: env.OTP_SMS_FALLBACK_DELAY_SECONDS,
    };
  }
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

export { HttpException };
