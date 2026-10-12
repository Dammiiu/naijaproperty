/**
 * Favourites: shortlisting an individual listing.
 *
 * Distinct from SavedSearch, which is a re-runnable filter. This is "keep this
 * one", and the two answer different questions.
 *
 * Toggle semantics are deliberate: `POST` adds or removes and reports which it
 * did, rather than `POST`/`DELETE` pairs. On a listing card the whole control is
 * one button, and a toggle cannot get out of step with what the server holds. The
 * unique constraint on (userId, listingId) makes a double-tap harmless.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ListingStatus } from '@prisma/client';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { publicImageUrl } from '../../common/media-url.js';
import { deriveBadges } from '../../common/badge-cap.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';

@ApiTags('favourites')
@Controller('favourites')
@UseGuards(JwtAuthGuard)
export class FavouritesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Listings the user has shortlisted' })
  async list(@Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const rows = await this.prisma.favourite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        listing: {
          include: {
            state: { select: { name: true } },
            lga: { select: { name: true } },
            area: { select: { name: true } },
            type: { select: { label: true } },
            poster: { select: { phoneVerifiedAt: true } },
            videoAsset: { select: { id: true } },
            media: {
              orderBy: { position: 'asc' },
              take: 1,
              select: { mediaAsset: { select: { id: true, storageKey: true } } },
            },
          },
        },
      },
    });

    return {
      items: rows.map((r) => {
        const l = r.listing;
        const cover = l.media[0]?.mediaAsset;
        const publishedAt = l.publishedAt ?? l.createdAt;

        return {
          id: l.id,
          favouriteId: r.id,
          note: r.note,
          savedAt: r.createdAt.toISOString(),
          kind: l.kindCode,
          typeLabel: l.type.label,
          title: l.title,
          price: Number(l.price),
          pricePeriod: l.pricePeriod,
          priceNegotiable: l.priceNegotiable,
          bedrooms: l.bedrooms,
          bathrooms: l.bathrooms,
          plotSqm: l.plotSqm,
          builtSqm: l.builtSqm,
          amenities: l.amenities,
          location: {
            areaName: l.area?.name ?? null,
            lgaName: l.lga.name,
            stateName: l.state.name,
          },
          coverImageUrl: cover ? publicImageUrl(cover.id, undefined, cover.storageKey) : null,
          videoCount: l.videoAsset ? 1 : 0,
          badges: deriveBadges({
            ownerPhoneVerified: l.poster.phoneVerifiedAt !== null,
            videoCount: l.videoAsset ? 1 : 0,
            titleVerified: l.titleVerifiedAt !== null,
            publishedAt,
          }),
          /*
           * A shortlist is not a promise the listing still exists. An agent who
           * takes a property down must not leave a card that 404s, so expired and
           * withdrawn rows are reported with their status rather than hidden.
           */
          status: l.status,
          isLive: l.status === ListingStatus.LIVE,
        };
      }),
    };
  }

  /**
   * Adds or removes a favourite.
   *
   * Returns `saved` so the client can render the correct state from the
   * response rather than assuming the toggle succeeded.
   */
  @Post('toggle')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add or remove one listing from the shortlist' })
  async toggle(@Body() body: unknown, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const parsed = z
      .object({
        listingId: z.string().cuid(),
        note: z.string().trim().max(280).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    // Confirms the listing exists and is visible. Without this a caller could
    // favourite an arbitrary id and later see a shortlist entry for it.
    const listing = await this.prisma.listing.findFirst({
      where: { id: parsed.data.listingId, status: ListingStatus.LIVE },
      select: { id: true },
    });
    if (!listing) throw ApiException.notFound('Listing not found');

    const existing = await this.prisma.favourite.findUnique({
      where: { userId_listingId: { userId, listingId: listing.id } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.favourite.delete({ where: { id: existing.id } });
      return { saved: false, listingId: listing.id };
    }

    await this.prisma.favourite.create({
      data: { userId, listingId: listing.id, note: parsed.data.note ?? null },
    });
    return { saved: true, listingId: listing.id };
  }

  /**
   * Which of the given listings are already shortlisted.
   *
   * Batched on purpose. A search page with 24 cards cannot issue 24 requests to
   * find out which heart is filled, so the client sends the ids it is already
   * displaying and gets one answer.
   */
  @Get('which')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Subset of the given ids that are shortlisted' })
  async which(@Query('ids') rawIds: string, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const ids = (rawIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => z.string().cuid().safeParse(s).success)
      // Bounded so the query cannot be used as an arbitrary scan.
      .slice(0, 100);

    if (ids.length === 0) return { listingIds: [] };

    const rows = await this.prisma.favourite.findMany({
      where: { userId, listingId: { in: ids } },
      select: { listingId: true },
    });

    return { listingIds: rows.map((r) => r.listingId) };
  }

  @Post(':id/note')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach a private note to a shortlisted listing' })
  async note(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const parsed = z.object({ note: z.string().trim().max(280) }).safeParse(body);
    if (!parsed.success) {
      throw ApiException.validation([
        { path: 'note', message: 'A note can be at most 280 characters' },
      ]);
    }

    const result = await this.prisma.favourite.updateMany({
      where: { id, userId },
      data: { note: parsed.data.note || null },
    });

    if (result.count === 0) throw ApiException.notFound('Shortlisted listing not found');
    return { ok: true };
  }

  private userId(req: FastifyRequest): string {
    const sub = (req as AuthenticatedRequest).user?.sub;
    if (!sub) throw ApiException.unauthenticated();
    return sub;
  }
}