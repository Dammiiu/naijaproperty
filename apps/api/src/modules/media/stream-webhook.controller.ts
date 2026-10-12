/**
 * Cloudflare Stream webhook.
 *
 * The browser uploads video bytes straight to Cloudflare, so this callback is the
 * only signal that the video exists, finished encoding, and is playable. Nothing
 * in the request path can tell us: the browser may close the tab, the upload may
 * resume hours later, and encoding happens asynchronously on Cloudflare's side.
 *
 * Payload shape, verified against Cloudflare's documentation rather than assumed.
 * Three earlier assumptions here were all wrong and each would have made every
 * real webhook fail:
 *
 * 1. The video object is at the TOP LEVEL of the body, not nested under `video`.
 *    Reading `body.video` yields undefined on a genuine callback, so the handler
 *    would acknowledge it as `ignored` and the video would never become ready.
 * 2. `status` is an OBJECT (`{ state, pctComplete, errorReasonCode }`), not a
 *    string. A `READY_STATES.has(status)` check against an object never matches.
 * 3. The `Webhook-Signature` header is `time=<unix>,sig1=<hex>`, and the signed
 *    string is `<time>.<raw body>`. Comparing a bare hex HMAC of the body against
 *    the whole header string rejects 100% of real callbacks.
 *
 * Two further decisions worth stating:
 *
 * - Signature verification is mandatory and rejects everything when no secret is
 *   configured. This endpoint can mark a video READY and therefore publish it, so
 *   "no secret configured" must mean closed, not open.
 * - Events are deduplicated on (uid, state) before anything is applied. Cloudflare
 *   retries until it sees a 200, and a duplicate returns 200 with `duplicate: true`
 *   rather than an error, because answering an error to a retry makes it retry
 *   again.
 */

import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import { MediaStatus } from '@prisma/client';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { getEnv } from '../../config/env.js';

/**
 * Cloudflare's `status` object.
 *
 * Both spellings appear in their documentation (`errorReasonCode` in the field
 * list, `errReasonCode` in the error example), so both are read. Reading only one
 * would silently discard the reason on whichever shape Cloudflare happens to send.
 */
interface StreamStatus {
  state?: string;
  step?: string;
  pctComplete?: string | number;
  errorReasonCode?: string;
  errorReasonText?: string;
  errReasonCode?: string;
  errReasonText?: string;
}

interface StreamVideo {
  uid?: string;
  thumbnail?: string;
  preview?: string;
  readyToStream?: boolean;
  status?: StreamStatus;
  meta?: Record<string, string | undefined>;
  duration?: number;
  input?: { width?: number; height?: number };
  playback?: { hls?: string; dash?: string };
  size?: number;
}

interface StreamWebhookBody extends StreamVideo {
  /** Older or alternate shape, where the video sits under a `video` key. */
  video?: StreamVideo;
}

/** Terminal-success states. Anything else is not ready. */
const READY_STATES = new Set(['ready']);

/**
 * How far a webhook's `time` field may be from our clock.
 *
 * The signature makes a replayed request cryptographically valid, so freshness has
 * to be checked separately. Five minutes is Cloudflare's own guidance and is wide
 * enough to absorb clock drift between here and their edge.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

@Controller('media')
export class StreamWebhookController {
  private readonly logger = new Logger('StreamWebhook');

  constructor(private readonly prisma: PrismaService) {}

  @Post('stream/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('webhook-signature') signature: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const env = getEnv();
    const secret = env.CLOUDFLARE_STREAM_WEBHOOK_SECRET;

    /*
     * Fail closed.
     *
     * Without a secret there is no way to know the caller is Cloudflare. Returning
     * 200 would look like working video uploads while nothing ever becomes ready,
     * and returning 503 makes Cloudflare retry a webhook we can never satisfy. A
     * 401 with a clear log fails visibly instead of quietly.
     */
    if (!secret) {
      this.logger.error(
        'Stream webhook called but CLOUDFLARE_STREAM_WEBHOOK_SECRET is not set. Rejecting: ' +
          'without it there is no way to verify the caller, and this endpoint can publish video.',
      );
      throw new ApiException('UNAUTHENTICATED', 'Webhook not configured', 401);
    }

    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw)) {
      // Re-serialising the parsed JSON would change the bytes the signature covers.
      this.logger.error('Stream webhook arrived without a raw body; cannot verify signature');
      throw new ApiException('VALIDATION_FAILED', 'Raw body unavailable', 400);
    }

    if (!signature || !this.verify(raw, signature, secret)) {
      this.logger.warn('Rejected Stream webhook with an invalid or stale signature');
      throw new ApiException('UNAUTHENTICATED', 'Invalid signature', 401);
    }

    let body: StreamWebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as StreamWebhookBody;
    } catch {
      throw new ApiException('VALIDATION_FAILED', 'Body is not JSON', 400);
    }

    /*
     * Accept both documented shapes.
     *
     * Cloudflare's current payload puts the video at the top level; an older form
     * nests it under `video`. Reading only one of the two would mean a real
     * callback is silently acknowledged and ignored, which is precisely the failure
     * that looks like "video upload is broken" with nothing in the logs.
     */
    const video: StreamVideo = body.video ?? body;
    const uid = video.uid;
    if (!uid) {
      // No video is not an error; acknowledge so Cloudflare stops retrying.
      return reply.code(200).send({ received: true, ignored: true, reason: 'no video in payload' });
    }

    const state = video.status?.state ?? '';
    const externalId = `${uid}:${state}`;

    // Deduplicate before applying. The uid alone is wrong: a re-encode legitimately
    // re-sends `ready` for the same video, and collapsing those would leave a stale
    // playback URL on the asset.
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: 'CLOUDFLARE_STREAM',
          externalId,
          eventType: state || 'unknown',
          payload: body as object,
          signatureValid: true,
        },
      });
    } catch {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    const assetId = video.meta?.assetId;
    const asset = assetId
      ? await this.prisma.mediaAsset.findUnique({
          where: { id: assetId },
          select: { id: true, streamUid: true, status: true },
        })
      : await this.prisma.mediaAsset.findFirst({
          where: { streamUid: uid },
          select: { id: true, streamUid: true, status: true },
        });

    if (!asset) {
      await this.markProcessed(externalId);
      this.logger.warn(`Stream event ${externalId} referenced an unknown asset`);
      return reply.code(200).send({ received: true, unmatched: true });
    }

    /*
     * Guard against a mismatched uid.
     *
     * This is the one place where a wrong match would publish the wrong video on
     * the wrong listing. `meta` is only as trustworthy as the signature, and the
     * signature only proves the payload came from Cloudflare, so the binding is
     * checked rather than assumed.
     */
    if (asset.streamUid && asset.streamUid !== uid) {
      this.logger.error(
        `Stream webhook uid ${uid} claims asset ${asset.id}, which is bound to ${asset.streamUid}. Ignoring.`,
      );
      return reply.code(200).send({ received: true, ignored: true, reason: 'uid mismatch' });
    }

    const errorReason =
      video.status?.errorReasonText ??
      video.status?.errReasonText ??
      video.status?.errorReasonCode ??
      video.status?.errReasonCode;

    if (READY_STATES.has(state)) {
      /*
       * `readyToStream` is checked alongside the state.
       *
       * Cloudflare sets `status.state` to `ready` once encoding has finished, but
       * also states that a video must have `readyToStream: true` before it plays.
       * Trusting the state alone can store a manifest that serves nothing yet.
       */
      const playable = video.readyToStream === true && Boolean(video.playback?.hls);

      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: MediaStatus.READY,
          readyAt: new Date(),
          // Stream reports seconds. A walkthrough is typically minutes, so storing
          // seconds verbatim would render as 0:00 in the player.
          durationMs: typeof video.duration === 'number' ? Math.round(video.duration * 1000) : null,
          width: video.input?.width ?? null,
          height: video.input?.height ?? null,
          // Taken verbatim from the payload rather than reconstructed from a guessed
          // hostname. The customer subdomain (`customer-f33zs165nr7gyfy4`) is not
          // exposed anywhere on the account object, so deriving it meant guessing
          // and produced URLs that 404.
          playbackHls: playable ? (video.playback?.hls ?? null) : null,
          posterUrl: video.thumbnail ?? null,
        },
      });

      /*
       * Moderation is not implied by successful encoding.
       *
       * A file that encodes cleanly can still be someone else's property, or a
       * recording of a conversation. `moderationStatus` stays PENDING and is decided
       * in review, which is what makes the video badge on a card a claim rather than
       * a decoration.
       */
      await this.markProcessed(externalId);
      this.logger.log(
        `Stream video ${uid} ready (asset ${asset.id}, playable=${playable}, pct=${video.status?.pctComplete ?? '?'})`,
      );
      return reply.code(200).send({ received: true, ready: true, playable });
    }

    if (state === 'error') {
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: MediaStatus.FAILED,
          moderationNotes: errorReason ?? 'Stream could not process this video',
        },
      });
      await this.markProcessed(externalId);
      this.logger.error(`Stream video ${uid} failed: ${errorReason ?? 'no reason given'}`);
      return reply.code(200).send({ received: true, failed: true });
    }

    // Intermediate states. Recorded, not applied.
    await this.markProcessed(externalId);
    return reply.code(200).send({ received: true, state });
  }

  private async markProcessed(externalId: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { provider: 'CLOUDFLARE_STREAM', externalId },
      data: { processedAt: new Date() },
    });
  }

  /**
   * Verifies Cloudflare's `Webhook-Signature` header.
   *
   * The header looks like `time=1230811200,sig1=<hex>` and the signed string is
   * `<time>.<raw body>`, not the body alone. The timestamp is checked as well as
   * the signature: an attacker who captures one valid request can replay it
   * indefinitely otherwise, since the signature stays cryptographically correct.
   */
  private verify(raw: Buffer, header: string, secret: string): boolean {
    let time: string | undefined;
    const signatures: string[] = [];

    for (const part of header.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === 'time') time = value;
      // Accept any sigN, not just sig1, so a future rotation of key count does not
      // silently reject every callback.
      else if (key.startsWith('sig')) signatures.push(value);
    }

    if (!time || signatures.length === 0) return false;

    const sent = Number(time);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Date.now() / 1000 - sent) > SIGNATURE_TOLERANCE_SECONDS) return false;

    // The source string concatenates the timestamp, a literal dot, then the body
    // exactly as received.
    const expected = createHmac('sha256', secret).update(`${time}.`).update(raw).digest('hex');

    return signatures.some((sig) => {
      const given = sig.toLowerCase();
      if (given.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
    });
  }
}
