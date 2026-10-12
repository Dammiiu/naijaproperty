import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ListingStatus, ReviewStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { deriveBadges } from '../../common/badge-cap.js';
import { publicImageUrl } from '../../common/media-url.js';
import { SearchService } from '../search/search.service.js';
import {
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  type AuthenticatedRequest,
} from '../auth/jwt-auth.guard.js';
import {
  createReviewRequestSchema,
  reviewVoteValueSchema,
  type ReviewResponse,
  type ReviewsListResponse,
  type ReviewSummary,
} from '@naijaproperty/contracts';

@ApiTags('listings')
@Controller('listings')
export class ListingDetailController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly search: SearchService,
  ) {}

  /**
   * Public listing detail.
   *
   * This is the endpoint the SEO surface depends on, so it must be cheap and it
   * must never leak. `exactAddressEnc` and the poster's `phoneEnc` are selected
   * but only decrypted when the requester is entitled to see them:
   *
   *   - the owner always sees their own address
   *   - anyone else sees it only after a successful contact reveal
   *
   * The reveal itself still happens at POST /listings/reveal, which writes the
   * audit row. This endpoint is read-only; it only decides whether to fill in
   * values that have already been unlocked.
   */
  @Get(':id')
  // Optional, not required: anonymous visitors must still get the page, but a
  // viewer who has already unlocked the contact has to get the unlocked state.
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public listing detail' })
  async detail(
    @Param('id') rawId: string,
    @Req() req: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const id = z.string().cuid().safeParse(rawId);
    if (!id.success) throw ApiException.notFound('Listing not found');

    const listing = await this.prisma.listing.findUnique({
      where: { id: id.data },
      include: {
        area: { select: { name: true } },
        lga: { select: { name: true } },
        state: { select: { name: true } },
        type: { select: { code: true, label: true } },
        videoAsset: {
          select: { streamUid: true, posterUrl: true, playbackHls: true, durationMs: true },
        },
        media: {
          orderBy: { position: 'asc' },
          select: {
            isCover: true,
            mediaAsset: {
              select: {
                id: true,
                blurhash: true,
                dominantColor: true,
                width: true,
                height: true,
                storageKey: true,
                moderationStatus: true,
              },
            },
          },
        },
        poster: {
          select: {
            id: true,
            displayName: true,
            verificationTier: true,
            phoneVerifiedAt: true,
            createdAt: true,
            phoneEnc: true,
            agentProfile: {
              select: { agencyName: true, licenceVerifiedAt: true },
            },
          },
        },
        contactReveals: {
          where: { revokedAt: null },
          select: { viewerId: true },
          take: 500,
        },
      },
    });

    if (!listing) throw ApiException.notFound('Listing not found');

    // A listing that is not live is invisible to the public, including to a
    // search crawler, so a rejected or under-review property cannot be
    // discovered by guessing its id.
    if (listing.status !== ListingStatus.LIVE) {
      throw ApiException.notFound('Listing not found');
    }

    const viewerId = (req as AuthenticatedRequest).user?.sub ?? null;
    const isOwner = viewerId !== null && listing.posterId === viewerId;
    const hasRevealed = viewerId !== null && listing.contactReveals.some((r) => r.viewerId === viewerId);

    const maySeeContact = isOwner || hasRevealed;

    void listing.viewCount;
    // Fire-and-forget: a view counter must never slow the response.
    this.prisma.listing
      .update({ where: { id: listing.id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    const publishedAt = listing.publishedAt ?? listing.createdAt;

    let exactAddress: string | null = null;
    let ownerPhone: string | null = null;
    let conversationId: string | null = null;

    if (maySeeContact) {
      try {
        exactAddress = listing.exactAddressEnc
          ? this.pii.decrypt(listing.exactAddressEnc)
          : null;
        ownerPhone = listing.poster.phoneEnc ? this.pii.decrypt(listing.poster.phoneEnc) : null;
      } catch {
        // A decryption failure must not 500 the page. The poster sees a locked
        // state and can still reach support.
        exactAddress = null;
        ownerPhone = null;
      }

      if (viewerId && !isOwner) {
        /*
         * Upsert, not findUnique.
         *
         * A reveal row can outlive its conversation (moderation purge, data
         * cleanup). Returning null there left the page with no thread id, so the
         * "Message the owner" button had to create one on click and the viewer
         * lost the thread they already had. Self-healing on read keeps the button
         * a straight link and repairs the row at the same time.
         */
        const conversation = await this.prisma.conversation.upsert({
          where: { listingId_initiatorId: { listingId: listing.id, initiatorId: viewerId } },
          create: { listingId: listing.id, initiatorId: viewerId, ownerId: listing.posterId },
          update: {},
          select: { id: true },
        });
        conversationId = conversation.id;
      }
    }

    const video =
      listing.videoAsset && listing.videoAsset.streamUid
        ? {
            streamUid: listing.videoAsset.streamUid,
            posterUrl: listing.videoAsset.posterUrl,
            playbackHls: listing.videoAsset.playbackHls,
            durationMs: listing.videoAsset.durationMs,
          }
        : null;

    return {
      id: listing.id,
      kind: listing.kindCode,
      type: listing.typeCode,
      typeLabel: listing.type.label,
      title: listing.title,
      description: listing.description,
      price: Number(listing.price),
      pricePeriod: listing.pricePeriod,
      priceNegotiable: listing.priceNegotiable,
      paymentAdvance: listing.paymentAdvance,
      agencyFee: listing.agencyFee ? Number(listing.agencyFee) : null,
      minimumStayMonths: listing.minimumStayMonths,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      plotSqm: listing.plotSqm,
      builtSqm: listing.builtSqm,
      amenities: listing.amenities,
      dealType: listing.deedType,
      location: {
        areaName: listing.area?.name ?? null,
        lgaName: listing.lga.name,
        stateName: listing.state.name,
      },
      coverImageUrl: listing.media[0]
        ? publicImageUrl(
            listing.media[0].mediaAsset.id,
            undefined,
            listing.media[0].mediaAsset.storageKey,
          )
        : null,
      videoCount: video ? 1 : 0,
      badges: deriveBadges({
        ownerPhoneVerified: listing.poster.phoneVerifiedAt !== null,
        videoCount: video ? 1 : 0,
        titleVerified: listing.titleVerifiedAt !== null,
        publishedAt,
      }),
      status: listing.status,
      publishedAt: publishedAt.toISOString(),
      viewCount: listing.viewCount,
      contactClickCount: listing.contactClickCount,
      media: listing.media.map((m) => ({
        id: m.mediaAsset.id,
        url: publicImageUrl(m.mediaAsset.id, undefined, m.mediaAsset.storageKey),
        blurhash: m.mediaAsset.blurhash,
        dominantColor: m.mediaAsset.dominantColor,
        isCover: m.isCover,
      })),
      video,
      poster: {
        displayName: listing.poster.displayName,
        verificationTier: listing.poster.verificationTier,
        memberSince: listing.poster.createdAt.toISOString(),
        agencyName: listing.poster.agentProfile?.agencyName ?? null,
        agencyLicenceVerified: listing.poster.agentProfile?.licenceVerifiedAt != null,
      },
      // Null unless the requester is entitled. The client renders a locked row.
      exactAddress,
      ownerPhone,
      conversationId,
      isOwner,
      contactRevealed: hasRevealed,
    };
  }

  /**
   * Similar listings in the same area.
   *
   * Returns up to 5 other LIVE listings of the same kind (RENT/SALE) that share
   * the area, LGA, or state. The order of preference is:
   *   1. Same area (most specific)
   *   2. Same LGA
   *   3. Same state
   *
   * The current listing is always excluded. This endpoint is public and does not
   * require authentication, since it only surfaces information already visible
   * on the listing detail page.
   */
  @Get(':id/similar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Similar listings in the same area' })
  async similar(
    @Param('id') rawId: string,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const id = z.string().cuid().safeParse(rawId);
    if (!id.success) throw ApiException.notFound('Listing not found');

    const listing = await this.prisma.listing.findUnique({
      where: { id: id.data },
      select: {
        id: true,
        kindCode: true,
        status: true,
        areaId: true,
        lgaId: true,
        stateCode: true,
      },
    });
    if (!listing) throw ApiException.notFound('Listing not found');
    if (listing.status !== ListingStatus.LIVE) {
      throw ApiException.notFound('Listing not found');
    }

    /*
     * Try area first, then LGA, then state. We chain the attempts because the
     * area might have few listings, and falling back gives a better UX than
     * returning an empty array.
     */
    const trySearch = async (filters: { areaId?: string; lgaId?: string; stateCode?: string }) => {
      const result = await this.search.search({
        kind: listing.kindCode,
        areaId: filters.areaId ? [filters.areaId] : undefined,
        lgaCode: filters.lgaId ? [filters.lgaId] : undefined,
        stateCode: filters.stateCode ? [filters.stateCode] : undefined,
        limit: 6, // fetch one extra to account for excluding the current listing
      });
      return result.items.filter((item) => item.id !== listing.id).slice(0, 5);
    };

    // 1. Same area (most specific)
    if (listing.areaId) {
      const items = await trySearch({ areaId: listing.areaId });
      if (items.length > 0) return { items };
    }

    // 2. Same LGA
    if (listing.lgaId) {
      const items = await trySearch({ lgaId: listing.lgaId });
      if (items.length > 0) return { items };
    }

    // 3. Same state (broadest)
    if (listing.stateCode) {
      const items = await trySearch({ stateCode: listing.stateCode });
      if (items.length > 0) return { items };
    }

    return { items: [] };
  }

  /**
   * List reviews for a listing.
   *
   * Returns paginated reviews with vote counts and the current user's vote (if any).
   * Only PUBLISHED reviews are returned to the public.
   */
  @Get(':id/reviews')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'List reviews for a listing' })
  async reviews(
    @Param('id') rawId: string,
    @Req() req: FastifyRequest<{ Querystring: { cursor?: string; limit?: string } }>,
  ): Promise<ReviewsListResponse> {
    const id = z.string().cuid().safeParse(rawId);
    if (!id.success) throw ApiException.notFound('Listing not found');

    const listing = await this.prisma.listing.findUnique({
      where: { id: id.data },
      select: { id: true, status: true },
    });
    if (!listing || listing.status !== ListingStatus.LIVE) {
      throw ApiException.notFound('Listing not found');
    }

    const viewerId = (req as AuthenticatedRequest).user?.sub ?? null;
    const cursor = req.query.cursor;
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const where: Prisma.ReviewWhereInput = {
      listingId: id.data,
      status: ReviewStatus.PUBLISHED,
    };

    const [items, totalCount] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          listingId: true,
          authorId: true,
          ratingOverall: true,
          ratingCommunication: true,
          ratingAccuracy: true,
          ratingValue: true,
          body: true,
          eligibility: true,
          status: true,
          createdAt: true,
          author: {
            select: {
              displayName: true,
              verificationTier: true,
            },
          },
          _count: {
            select: { votes: true },
          },
          /*
           * Always selected, filtered to the viewer when there is one.
           *
           * Previously this was `viewerId ? {...} : false`, and `false` is not a
           * valid Prisma select value: it omits the field entirely rather than
           * returning an empty array. Anonymous browsing then hit
           * `r.votes.filter` on undefined and the whole reviews endpoint 500'd
           * for every signed-out visitor, which is the majority of traffic.
           *
           * A `where` that matches nothing costs nothing and always returns an
           * array, so the shape is stable either way.
           */
          votes: {
            where: { userId: viewerId ?? '__anonymous__' },
            select: { value: true },
            take: 1,
          },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const next = items.pop()!;
      nextCursor = next.id;
    }

    /*
     * Aggregate over every published review, not just this page.
     *
     * Computing this from `items` would be wrong twice over: it would only
     * average the first page, and it would change every time a reader opened a
     * different page or passed a cursor. A reputation score that moves when you
     * paginate is not a reputation score.
     */
    const [grouped, subTotals] = await Promise.all([
      this.prisma.review.groupBy({
        by: ['ratingOverall'],
        where,
        _count: { _all: true },
      }),
      this.prisma.review.aggregate({
        where,
        _avg: {
          ratingCommunication: true,
          ratingAccuracy: true,
          ratingValue: true,
        },
      }),
    ]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let weighted = 0;
    let count = 0;
    for (const row of grouped) {
      const n = row._count._all;
      distribution[row.ratingOverall as 1 | 2 | 3 | 4 | 5] = n;
      weighted += row.ratingOverall * n;
      count += n;
    }

    const summary: ReviewSummary = {
      // Null, not 0. A listing nobody has reviewed yet must not read as the
      // worst listing on the site.
      average: count > 0 ? Math.round((weighted / count) * 10) / 10 : null,
      count,
      distribution,
      communicationAverage: subTotals._avg.ratingCommunication,
      accuracyAverage: subTotals._avg.ratingAccuracy,
      valueAverage: subTotals._avg.ratingValue,
    };

    const formattedItems: ReviewResponse[] = items.map((r) => {
      // Map VerificationTier to contract enum (NONE -> UNVERIFIED)
      const tierMap: Record<string, 'UNVERIFIED' | 'PHONE_VERIFIED' | 'DOCUMENT_VERIFIED'> = {
        NONE: 'UNVERIFIED',
        PHONE_VERIFIED: 'PHONE_VERIFIED',
        DOCUMENT_VERIFIED: 'DOCUMENT_VERIFIED',
      };
      return {
        id: r.id,
        listingId: r.listingId,
        authorId: r.authorId,
        authorDisplayName: r.author.displayName,
        authorVerificationTier: tierMap[r.author.verificationTier] ?? 'UNVERIFIED',
        ratingOverall: r.ratingOverall,
        ratingCommunication: r.ratingCommunication ?? undefined,
        ratingAccuracy: r.ratingAccuracy ?? undefined,
        ratingValue: r.ratingValue ?? undefined,
        body: r.body,
        eligibility: r.eligibility,
        status: r.status,
        helpfulCount: r.votes.filter((v) => v.value === 1).length,
        notHelpfulCount: r.votes.filter((v) => v.value === -1).length,
        userVote: r.votes[0]?.value ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });

    // `summary` is returned alongside the page. It used to be computed and then
    // dropped on the floor, so the UI had no rating to render and every listing
    // displayed its count as zero no matter how many reviews it actually had.
    return { items: formattedItems, nextCursor, totalCount, summary };
  }

  /**
   * Create a review for a listing.
   *
   * The reviewer must be eligible: either they have revealed the contact (contactReveal)
   * or they have a confirmed StayRecord. This prevents fake reviews from people
   * who never interacted with the property.
   */
  @Post(':id/reviews')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 3600_000 } })
  @ApiOperation({ summary: 'Create a review for a listing' })
  async createReview(
    @Param('id') rawId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    const id = z.string().cuid().safeParse(rawId);
    if (!id.success) throw ApiException.notFound('Listing not found');

    const listing = await this.prisma.listing.findUnique({
      where: { id: id.data },
      select: { id: true, status: true, kindCode: true, posterId: true },
    });
    if (!listing || listing.status !== ListingStatus.LIVE) {
      throw ApiException.notFound('Listing not found');
    }

    const authorId = req.user?.sub;
    if (!authorId) throw ApiException.unauthenticated();

    // Cannot review your own listing
    if (listing.posterId === authorId) {
      throw ApiException.forbidden('You cannot review your own listing');
    }

    // Check if already reviewed
    const existing = await this.prisma.review.findUnique({
      where: { listingId_authorId: { listingId: id.data, authorId } },
      select: { id: true },
    });
    if (existing) {
      throw ApiException.conflict('CONFLICT', 'You have already reviewed this listing');
    }

    // Parse and validate body
    const body = createReviewRequestSchema.safeParse(req.body);
    if (!body.success) {
      throw ApiException.validation(
        body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    // Verify eligibility
    let eligible = false;
    if (body.data.eligibility === 'REVEALED') {
      const reveal = await this.prisma.contactReveal.findUnique({
        where: { listingId_viewerId: { listingId: id.data, viewerId: authorId } },
        select: { id: true, revokedAt: true },
      });
      eligible = Boolean(reveal && !reveal.revokedAt);
    } else if (body.data.eligibility === 'STAY_RECORDED') {
      const stay = await this.prisma.stayRecord.findFirst({
        where: {
          listingId: id.data,
          tenantId: authorId,
          ownerConfirmedAt: { not: null },
          tenantConfirmedAt: { not: null },
        },
        select: { id: true },
      });
      eligible = Boolean(stay);
    } else if (body.data.eligibility === 'ADMIN_OVERRIDE') {
      // Only staff can use this
      const { STAFF_ROLES } = await import('../auth/jwt-auth.guard.js');
      if (!req.user?.role || !STAFF_ROLES.includes(req.user.role)) {
        throw ApiException.forbidden('Admin override not permitted');
      }
      eligible = true;
    }

    if (!eligible) {
      throw ApiException.forbidden(
        'You are not eligible to review this listing. You must have either revealed the contact or completed a verified stay.',
      );
    }

    const review = await this.prisma.review.create({
      data: {
        listingId: id.data,
        authorId,
        ratingOverall: body.data.ratingOverall,
        ratingCommunication: body.data.ratingCommunication ?? null,
        ratingAccuracy: body.data.ratingAccuracy ?? null,
        ratingValue: body.data.ratingValue ?? null,
        body: body.data.body,
        eligibility: body.data.eligibility,
        status: ReviewStatus.PUBLISHED, // Auto-publish for now; moderation can flag later
      },
      select: { id: true },
    });

    return { id: review.id };
  }

  /**
   * Vote on a review (helpful / not helpful).
   */
  @Post('reviews/:reviewId/vote')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Vote on a review' })
  async voteReview(
    @Param('reviewId') rawReviewId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ helpfulCount: number; notHelpfulCount: number; userVote: number }> {
    const reviewId = z.string().cuid().safeParse(rawReviewId);
    if (!reviewId.success) throw ApiException.notFound('Review not found');

    const body = z.object({ value: reviewVoteValueSchema }).safeParse(req.body);
    if (!body.success) {
      throw ApiException.validation(
        body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const voterId = req.user?.sub;
    if (!voterId) throw ApiException.unauthenticated();

    // Check review exists and is published
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId.data },
      select: { id: true, status: true, authorId: true },
    });
    if (!review || review.status !== ReviewStatus.PUBLISHED) {
      throw ApiException.notFound('Review not found');
    }

    // Cannot vote on own review
    if (review.authorId === voterId) {
      throw ApiException.forbidden('You cannot vote on your own review');
    }

    const vote = await this.prisma.reviewVote.upsert({
      where: { reviewId_userId: { reviewId: reviewId.data, userId: voterId } },
      create: { reviewId: reviewId.data, userId: voterId, value: body.data.value },
      update: { value: body.data.value },
      select: { value: true },
    });

    const [helpfulCount, notHelpfulCount] = await Promise.all([
      this.prisma.reviewVote.count({
        where: { reviewId: reviewId.data, value: 1 },
      }),
      this.prisma.reviewVote.count({
        where: { reviewId: reviewId.data, value: -1 },
      }),
    ]);

    return { helpfulCount, notHelpfulCount, userVote: vote.value };
  }

  /**
   * Flag a review for moderation.
   */
  @Post('reviews/:reviewId/flag')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 3600_000 } })
  @ApiOperation({ summary: 'Flag a review for moderation' })
  async flagReview(
    @Param('reviewId') rawReviewId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ flagged: boolean }> {
    const reviewId = z.string().cuid().safeParse(rawReviewId);
    if (!reviewId.success) throw ApiException.notFound('Review not found');

    const body = z.object({ reason: z.string().trim().min(10).max(500) }).safeParse(req.body);
    if (!body.success) {
      throw ApiException.validation(
        body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const flaggerId = req.user?.sub;
    if (!flaggerId) throw ApiException.unauthenticated();

    const review = await this.prisma.review.findUnique({
      where: { id: reviewId.data },
      select: { id: true, status: true, authorId: true },
    });
    if (!review || review.status !== ReviewStatus.PUBLISHED) {
      throw ApiException.notFound('Review not found');
    }

    // Cannot flag own review
    if (review.authorId === flaggerId) {
      throw ApiException.forbidden('You cannot flag your own review');
    }

    await this.prisma.review.update({
      where: { id: reviewId.data },
      data: { status: ReviewStatus.FLAGGED },
    });

    return { flagged: true };
  }

  /**
   * Server-side cookie gate. Lets a page render the unlocked state after a
   * reveal without the client holding a long-lived token.
   */
  @Get(':id/contact-status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether the viewer has already unlocked this contact' })
  async contactStatus(@Param('id') rawId: string, @Req() req: FastifyRequest) {
    const id = z.string().cuid().safeParse(rawId);
    if (!id.success) throw ApiException.notFound('Listing not found');

    const viewerId = (req as AuthenticatedRequest).user?.sub;
    if (!viewerId) throw ApiException.unauthenticated();

    const listing = await this.prisma.listing.findUnique({
      where: { id: id.data },
      select: { id: true, posterId: true, poster: { select: { phoneEnc: true } } },
    });
    if (!listing) throw ApiException.notFound('Listing not found');

    const reveal = await this.prisma.contactReveal.findUnique({
      where: { listingId_viewerId: { listingId: listing.id, viewerId } },
      select: { revealedAt: true, revokedAt: true },
    });

    return {
      isOwner: listing.posterId === viewerId,
      revealed: Boolean(reveal && !reveal.revokedAt),
      ownerHasPhone: Boolean(listing.poster.phoneEnc),
      revealedAt: reveal?.revealedAt?.toISOString() ?? null,
    };
  }
}

export type { Prisma };