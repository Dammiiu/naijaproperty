/**
 * The poster's own listings.
 *
 * Separate from public search because it is a different question: not "what can
 * I find" but "what did I post, and what is happening to it". Status is the first
 * thing shown, because the most common reason to open this page is to check
 * whether a listing is still sitting in review.
 *
 * Also the only surface that reveals a poster's own exact address, since the
 * owner has already unlocked it by definition.
 */

import { Controller, Get, HttpCode, HttpStatus, Post, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { publicImageUrl } from '../../common/media-url.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ListingsService } from './listings.service.js';

@ApiTags('listings')
@Controller('my/listings')
@UseGuards(JwtAuthGuard)
export class MyListingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly listings: ListingsService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Listings the signed-in user posted' })
  async mine(@Req() req: FastifyRequest, @Query('status') rawStatus?: string) {
    const userId = (req as AuthenticatedRequest).user?.sub;
    if (!userId) throw ApiException.unauthenticated();

    // A narrow allow-list rather than passing the value straight through, so a
    // malformed status can never become a filter on an unexpected column.
    const allowed = ['DRAFT', 'PENDING_REVIEW', 'LIVE', 'CHANGES_REQUESTED', 'REJECTED', 'EXPIRED'];
    const status = rawStatus && allowed.includes(rawStatus) ? rawStatus : undefined;

    const listings = await this.prisma.listing.findMany({
      where: { posterId: userId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        state: { select: { name: true } },
        lga: { select: { name: true } },
        area: { select: { name: true } },
        type: { select: { label: true } },
        media: {
          orderBy: { position: 'asc' },
          take: 1,
          select: {
            mediaAsset: { select: { id: true, storageKey: true, width: true, height: true } },
          },
        },
        reviewEvents: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { action: true, reasonCode: true, note: true, createdAt: true },
        },
        _count: { select: { media: true, contactReveals: true, conversations: true } },
      },
    });

    return {
      items: listings.map((l) => {
        /*
         * The poster's own address. This is the one place decryption is correct:
         * the owner is entitled to see what they wrote. Everyone else goes through
         * the reveal flow, which writes an audit row.
         */
        let exactAddress: string | null = null;
        try {
          exactAddress = l.exactAddressEnc ? this.pii.decrypt(l.exactAddressEnc) : null;
        } catch {
          exactAddress = null;
        }

        const cover = l.media[0]?.mediaAsset;

        return {
          id: l.id,
          kind: l.kindCode,
          typeLabel: l.type.label,
          title: l.title,
          status: l.status,
          price: Number(l.price),
          pricePeriod: l.pricePeriod,
          location: {
            areaName: l.area?.name ?? null,
            lgaName: l.lga.name,
            stateName: l.state.name,
          },
          coverImageUrl: cover ? publicImageUrl(cover.id, undefined, cover.storageKey) : null,
          exactAddress,
          photoCount: l._count.media,
          revealCount: l._count.contactReveals,
          conversationCount: l._count.conversations,
          viewCount: l.viewCount,
          createdAt: l.createdAt.toISOString(),
          publishedAt: l.publishedAt?.toISOString() ?? null,
          // Surfaced so the poster can act on it rather than guessing why a
          // listing is not live.
          rejectionReason: l.rejectionReason,
          slaDueAt: l.slaDueAt?.toISOString() ?? null,
          events: l.reviewEvents.map((e) => ({
            action: e.action,
            reasonCode: e.reasonCode,
            note: e.note,
            at: e.createdAt.toISOString(),
          })),
        };
      }),
    };
  }

  /**
   * Resubmits a draft or a listing that came back for changes.
   *
   * Delegates to the same ListingsService.submit used on a first submission, so
   * auto-moderation runs again and the SLA is re-armed. A poster must not be able
   * to fix one thing and slip past the checks on a second attempt — which is why
   * this is a service call and not a raw status flip.
   */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resubmit a draft or a listing that was sent back' })
  async resubmit(@Param('id') id: string, @Req() req: FastifyRequest) {
    const parsed = z.string().cuid().safeParse(id);
    if (!parsed.success) throw ApiException.notFound('Listing not found');

    const user = (req as AuthenticatedRequest).user;
    if (!user) throw ApiException.unauthenticated();

    // Scoped to the poster's own listings, so nobody can resubmit another
    // person's draft by guessing an id.
    const listing = await this.prisma.listing.findFirst({
      where: { id: parsed.data, posterId: user.sub },
      select: { id: true, status: true },
    });
    if (!listing) throw ApiException.notFound('Listing not found');

    if (listing.status !== 'DRAFT' && listing.status !== 'CHANGES_REQUESTED') {
      throw ApiException.validation([
        { path: 'status', message: `A listing that is ${listing.status} cannot be resubmitted` },
      ]);
    }

    return this.listings.submit(listing.id, user.sub);
  }
}