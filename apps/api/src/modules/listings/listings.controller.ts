import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiException, revealRequestSchema } from '@naijaproperty/contracts';
import { RevealService } from './reveal.service.js';
import { ListingsService } from './listings.service.js';
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  STAFF_ROLES,
  type AuthenticatedRequest,
} from '../auth/jwt-auth.guard.js';

@ApiTags('listings')
@Controller('listings')
export class ListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly reveal: RevealService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a listing draft' })
  async create(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.listings.createDraft(body, userId(req));
  }

  @Post(':id/submit')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit a draft for admin review' })
  async submit(@Param('id') id: string, @Req() req: FastifyRequest) {
    const parsed = z.string().cuid().safeParse(id);
    if (!parsed.success) throw ApiException.notFound('Listing not found');
    return this.listings.submit(parsed.data, userId(req));
  }

  /**
   * Contact reveal. The only endpoint in the system that returns a decrypted
   * phone number or exact address.
   */
  @Post('reveal')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Unlock an owner contact and exact address' })
  async revealContact(@Body() body: unknown, @Req() req: FastifyRequest) {
    const parsed = revealRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return this.reveal.reveal({
      viewerId: userId(req),
      listingId: parsed.data.listingId,
      ip: req.ip,
      channel: 'WEB',
    });
  }
}

/**
 * Admin review surface. Kept on a separate controller so the guard stack and the
 * audit expectations are visibly distinct from the public routes.
 */
@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)

export class AdminListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Get('review/queue')
  @ApiOperation({ summary: 'Review queue health and SLA telemetry' })
  async queue() {
    return this.listings.queueStats();
  }

  @Post('review/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve, reject, or request changes on a listing' })
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const parsedId = z.string().cuid().safeParse(id);
    if (!parsedId.success) throw ApiException.notFound('Listing not found');

    const decision = z
      .object({
        action: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'ESCALATED']),
        reasonCode: z.string().max(64).optional(),
        note: z.string().max(2000).optional(),
      })
      .safeParse(body);

    if (!decision.success) {
      throw ApiException.validation(
        decision.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const auth = req as AuthenticatedRequest;
    const user = auth.user;
    if (!user) throw ApiException.unauthenticated();

    return this.listings.review(parsedId.data, {
      id: user.sub,
      role: user.role,
      scope: user.scope,
    }, decision.data);
  }
}

function userId(req: FastifyRequest): string {
  const id = (req as AuthenticatedRequest).user?.sub;
  if (!id) throw ApiException.unauthenticated();
  return id;
}
