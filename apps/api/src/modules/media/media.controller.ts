import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  completeUploadSchema,
  presignImageRequestSchema,
  presignVideoRequestSchema,
} from '@naijaproperty/contracts';
import { ApiException } from '@naijaproperty/contracts';
import { MediaService } from './media.service.js';
import { MediaProcessingService } from './media-processing.service.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';

@ApiTags('media')
@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly processing: MediaProcessingService,
  ) {}

  /**
   * Issues a presigned R2 PUT. The browser then uploads directly, so image bytes
   * never transit this API.
   */
  @Post('images/presign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Presign a direct-to-R2 image upload' })
  async presignImage(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.media.presignImage(body, userId(req));
  }

  /** Issues a Cloudflare Stream Direct Creator Upload URL (tus, resumable). */
  @Post('videos/presign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Presign a direct-to-Stream video upload' })
  async presignVideo(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.media.presignVideo(body, userId(req));
  }

  /** Title deeds and agent licences. Quarantined until an admin accepts them. */
  @Post('documents/presign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Presign a document upload (title, licence)' })
  async presignDocument(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.media.presignDocument(body, userId(req));
  }

  @Post('images/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an image upload and begin processing' })
  async completeImage(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.media.completeImage(body, userId(req));
  }

  /**
   * Post an image to the processing queue immediately rather than waiting for
   * the worker's next tick. Useful when the poster is waiting on the result
   * before submitting a listing, which is the common case on mobile.
   */
  @Post('images/process')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Queue an uploaded image for post-processing now' })
  async processNow(@Body() body: unknown, @Req() req: FastifyRequest) {
    const parsed = z.object({ assetId: z.string().cuid() }).safeParse(body);
    if (!parsed.success) throw ApiException.notFound('Invalid asset');

    // Ownership is checked through the same path the status endpoint uses, so a
    // user cannot process someone else's upload.
    await this.media.statusForOwner(parsed.data.assetId, userId(req));
    const result = await this.processing.drainQueue();

    return { queued: true, ...result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Media processing state' })
  async status(@Param('id') id: string, @Req() req: FastifyRequest) {
    return this.media.statusForOwner(id, userId(req));
  }
}

function userId(req: FastifyRequest): string {
  const id = (req as AuthenticatedRequest).user?.sub;
  if (!id) throw ApiException.unauthenticated();
  return id;
}
