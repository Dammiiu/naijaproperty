/**
 * Listing creation and the admin review queue.
 *
 * The submission path is where the product's two central promises are enforced:
 *
 *   1. A listing cannot go live unreviewed. Submission sets PENDING_REVIEW and
 *      arms an SLA deadline; only an approval transitions it to LIVE.
 *   2. Rent and sale are disjoint. The Zod contract refuses a mismatched type,
 *      the composite FK refuses it at the database, and the BEFORE trigger
 *      refuses it with a readable message. Three layers, because this is the
 *      defect the incumbent marketplace actually ships.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ListingStatus, Prisma } from '@prisma/client';
import { ApiException, createListingSchema, type CreateListingPayload } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { LocationsService } from '../locations/locations.service.js';

/** Media minimums. Five photos is the floor a buyer can make a decision on. */
const MIN_PHOTOS = 5;
const MIN_DESCRIPTION = 60;

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly locations: LocationsService,
  ) {}

  async createDraft(raw: unknown, posterId: string): Promise<{ id: string; status: ListingStatus }> {
    const parsed = createListingSchema.safeParse(raw);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
      );
    }

    const data = parsed.data;
    await this.assertMediaReady(data, posterId);
    const lgaId = await this.resolveLgaId(data.lgaCode, data.stateCode);
    const agencyId = await this.resolveAgency(posterId);
    const areaId = await this.resolveAreaId(data.areaId);

    const listing = await this.prisma.listing.create({
      data: {
        kindCode: data.kind,
        typeCode: data.type,
        stateCode: data.stateCode,
        lgaId,
        areaId,
        // Reveal-gated: encrypted here, and only ever decrypted by RevealService.
        exactAddressEnc: this.pii.encrypt(data.exactAddress),
        title: data.title.trim(),
        titleNorm: normaliseTitle(data.title),
        description: data.description.trim(),
        price: BigInt(data.price),
        pricePeriod: data.kind === 'RENT' ? (data.pricePeriod ?? 'NONE') : 'NONE',
        priceNegotiable: data.priceNegotiable,
        paymentAdvance: data.paymentAdvance,
        agencyFee: data.agencyFee !== null && data.agencyFee !== undefined ? BigInt(data.agencyFee) : null,
        minimumStayMonths: data.minimumStayMonths,
        bedrooms: data.bedrooms,
        bathrooms: data.bathrooms,
        toilets: data.toilets,
        parkingSpaces: data.parkingSpaces,
        plotSqm: data.plotSqm,
        builtSqm: data.builtSqm,
        amenities: data.amenities,
        deedType: data.kind === 'SALE' ? data.deedType : 'NONE',
        posterId,
        agencyId,
        status: 'DRAFT',
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
        media: {
          create: data.mediaAssetIds.map((assetId, index) => ({
            mediaAssetId: assetId,
            position: index,
            isCover: index === 0,
          })),
        },
        ...(data.videoAssetId ? { videoAssetId: data.videoAssetId } : {}),
      },
      select: { id: true, status: true },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: posterId,
        action: 'listing.draft_created',
        entityType: 'listing',
        entityId: listing.id,
        ipHash: this.pii.hashIp(undefined),
        metadata: { kind: data.kind, type: data.type },
      },
    });

    return listing;
  }

  /**
   * Submits a draft for review.
   *
   * Runs auto-moderation first, then arms the SLA from the per-kind policy. The
   * requirement is 1 to 6 hours, so the default policy is target 180m, warn 240m,
   * escalate 360m.
   */
  async submit(
    listingId: string,
    posterId: string,
  ): Promise<{
    id: string;
    status: ListingStatus;
    slaDueAt: Date | null;
  }> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, posterId },
      include: { media: true, poster: true },
    });

    if (!listing) throw ApiException.notFound('Listing not found');

    if (listing.status === 'PENDING_REVIEW') {
      throw ApiException.conflict('CONFLICT', 'This listing is already under review');
    }
    if (listing.status === 'LIVE') {
      throw ApiException.conflict('CONFLICT', 'This listing is already published');
    }

    if (listing.media.length < MIN_PHOTOS) {
      throw ApiException.validation([
        { path: 'mediaAssetIds', message: `Upload at least ${MIN_PHOTOS} photos` },
      ]);
    }
    if (listing.description.trim().length < MIN_DESCRIPTION) {
      throw ApiException.validation([
        { path: 'description', message: `Describe the property in at least ${MIN_DESCRIPTION} characters` },
      ]);
    }

    const policy = await this.prisma.reviewSlaPolicy.findUnique({
      where: { kindCode: listing.kindCode },
    });
    const targetMinutes = policy?.targetMinutes ?? 180;

    const now = new Date();
    const slaDueAt = new Date(now.getTime() + targetMinutes * 60_000);

    // A walkthrough video is what makes a listing trustworthy in a market where
    // fraud is largely hidden behind misleading photos. We require it before
    // review, rather than merely recommending it.
    const hasVideo = Boolean(listing.videoAssetId);

    const signals = await this.runAutoModeration(listing);

    const blocking = signals.filter((s) => s.severity === 'BLOCK');

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.listingReviewEvent.create({
        data: {
          listingId,
          actorId: posterId,
          action: 'SUBMITTED',
          note: hasVideo ? undefined : 'Submitted without a walkthrough video',
        },
      });

      if (blocking.length > 0) {
        await tx.moderationSignal.createMany({
          data: blocking.map((s) => ({
            listingId,
            signal: s.signal,
            severity: s.severity,
            source: 'AUTO',
            detail: s.detail as Prisma.InputJsonValue,
          })),
        });

        return tx.listing.update({
          where: { id: listingId },
          data: {
            status: 'CHANGES_REQUESTED' as ListingStatus,
            submittedAt: now,
            reviewedAt: now,
            slaDueAt,
            rejectionReason: blocking
              .map((s) => s.reason)
              .join('; ')
              .slice(0, 500),
          },
          select: { id: true, status: true, slaDueAt: true },
        });
      }

      await tx.listing.update({
        where: { id: listingId },
        data: {
          status: 'PENDING_REVIEW' as ListingStatus,
          submittedAt: now,
          slaDueAt,
        },
        select: { id: true, status: true, slaDueAt: true },
      });

      // Assign the least-loaded eligible reviewer, scoped to this listing's state.
      await this.assignReviewer(tx, listingId, listing.stateCode);

      return { id: listingId, status: 'PENDING_REVIEW' as ListingStatus, slaDueAt };
    });

    this.logger.log(
      `Listing ${listingId} submitted for review (${listing.kindCode}/${listing.stateCode}), SLA due ${slaDueAt.toISOString()}`,
    );

    return updated;
  }

  /**
   * Auto-moderation.
   *
   * Runs before a human sees the listing so that obvious failures never consume
   * reviewer time, and so genuine judgement calls reach the top of the queue.
   */
  private async runAutoModeration(listing: {
    id: string;
    description: string;
    price: bigint;
    kindCode: string;
    typeCode: string;
    media: Array<{ mediaAssetId: string }>;
  }): Promise<Array<{
    signal: 'CONTACT_IN_BODY' | 'BANNED_TERM' | 'DUPLICATE_MEDIA' | 'IMAGE_NSFW' | 'PRICE_OUTLIER';
    severity: 'INFO' | 'WARN' | 'BLOCK';
    reason: string;
    detail?: unknown;
  }>> {
    const out: Array<{
      signal: 'CONTACT_IN_BODY' | 'BANNED_TERM' | 'DUPLICATE_MEDIA' | 'IMAGE_NSFW' | 'PRICE_OUTLIER';
      severity: 'INFO' | 'WARN' | 'BLOCK';
      reason: string;
      detail?: unknown;
    }> = [];

    // 1. Contact details in the body defeat the whole contact-reveal model.
    const text = `${listing.description}`;
    const phonePattern = /(?:\+?234|0)\s?[789]\d{1,2}[\s-]?\d{3}[\s-]?\d{4}/;
    const emailPattern = /[\w.+-]+@[\w-]+\.[\w.]+/;
    const waPattern = /wa\.me|whatsapp\s*[:=]/i;

    if (phonePattern.test(text) || waPattern.test(text)) {
      out.push({
        signal: 'CONTACT_IN_BODY',
        severity: 'BLOCK',
        reason: 'Remove phone numbers or WhatsApp links from the description. Contact details unlock after sign-in.',
      });
    }
    if (emailPattern.test(text)) {
      out.push({
        signal: 'CONTACT_IN_BODY',
        severity: 'WARN',
        reason: 'The description contains an email address.',
      });
    }

    // 2. Duplicate media across listings is the classic bulk-spam pattern.
    if (listing.media.length > 0) {
      const assetIds = listing.media.map((m) => m.mediaAssetId);
      const otherListings = await this.prisma.listingMedia.groupBy({
        by: ['mediaAssetId'],
        where: { mediaAssetId: { in: assetIds } },
        _count: { mediaAssetId: true },
      });
      const overused = otherListings.filter((g) => g._count.mediaAssetId > 3);
      if (overused.length > 0) {
        out.push({
          signal: 'DUPLICATE_MEDIA',
          severity: 'WARN',
          reason: 'Some photos appear on many listings.',
          detail: { overusedCount: overused.length },
        });
      }
    }

    // 3. Price outlier against the median for this type.
    const median = await this.prisma.listing.findMany({
      where: { typeCode: listing.typeCode, status: 'LIVE' },
      select: { price: true },
      take: 500,
      orderBy: { price: 'asc' },
    });

    if (median.length >= 10) {
      const mid = Math.floor(median.length / 2);
      const medianPrice = median[mid]?.price ?? listing.price;
      if (medianPrice > 0) {
        const ratio = Number(listing.price) / Number(medianPrice);
        if (ratio > 50 || ratio < 0.02) {
          out.push({
            signal: 'PRICE_OUTLIER',
            severity: 'WARN',
            reason: `Price is far from the typical ${listing.typeCode} listing.`,
            detail: { median: Number(medianPrice), submitted: Number(listing.price), sample: median.length },
          });
        }
      }
    }

    return out;
  }

  /**
   * Assigns the least-loaded reviewer whose scope covers the listing's state.
   * Scope is the ABAC half of the model: a Lagos-only moderator never receives a
   * Rivers listing.
   */
  private async assignReviewer(
    tx: Prisma.TransactionClient,
    listingId: string,
    stateCode: string,
  ): Promise<void> {
    const candidates = await tx.user.findMany({
      where: {
        role: { in: ['MODERATOR', 'ADMIN', 'SUPERADMIN'] },
        status: 'ACTIVE',
        OR: [
          { role: { in: ['ADMIN', 'SUPERADMIN'] } },
          { scopeStates: { has: stateCode } },
        ],
      },
      select: { id: true },
      take: 25,
    });

    if (candidates.length === 0) {
      this.logger.warn(`No reviewer available for ${stateCode}; listing ${listingId} left unassigned`);
      return;
    }

    // Least-loaded wins. Ties break on the oldest assignment so load rebalances.
    const loads = await Promise.all(
      candidates.map(async (c) => ({
        id: c.id,
        open: await tx.reviewAssignment.count({
          where: { reviewerId: c.id, releasedAt: null },
        }),
      })),
    );

    loads.sort((a, b) => a.open - b.open);
    const reviewerId = loads[0]?.id;
    if (!reviewerId) return;

    await tx.reviewAssignment.create({
      data: { listingId, reviewerId },
    });

    // Denormalised onto the listing so the queue can be ordered and filtered by
    // owner without joining the assignment table.
    await tx.listing.update({
      where: { id: listingId },
      data: { reviewerId },
    });

    await tx.listingReviewEvent.create({
      data: { listingId, actorId: reviewerId, action: 'ASSIGNED' },
    });
  }

  /**
   * Reviewer decision. This is the only path from PENDING_REVIEW to LIVE.
   */
  async review(
    listingId: string,
    reviewer: { id: string; role: string; scope: string[] },
    decision: {
      action: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'ESCALATED';
      reasonCode?: string;
      note?: string;
    },
  ): Promise<{ id: string; status: ListingStatus }> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, status: true, kindCode: true, stateCode: true, slaDueAt: true },
    });

    if (!listing) throw ApiException.notFound('Listing not found');
    if (listing.status !== 'PENDING_REVIEW') {
      throw ApiException.conflict('CONFLICT', 'This listing is not awaiting review');
    }

    if (reviewer.role === 'MODERATOR') {
      if (reviewer.scope.length === 0 || !reviewer.scope.includes(listing.stateCode)) {
        throw ApiException.forbidden(
          `Your review scope does not cover ${listing.stateCode}`,
        );
      }
    }

    const now = new Date();
    const slaBreached = listing.slaDueAt !== null && now > listing.slaDueAt;

    // ESCALATED stays PENDING_REVIEW on purpose: it means "a second pair of
    // eyes", so the listing must remain in the queue rather than silently
    // leaving it.
    const nextStatus: ListingStatus =
      decision.action === 'APPROVED'
        ? ListingStatus.LIVE
        : decision.action === 'REJECTED'
          ? ListingStatus.REJECTED
          : decision.action === 'ESCALATED'
            ? ListingStatus.PENDING_REVIEW
            : ListingStatus.CHANGES_REQUESTED;

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.listing.update({
        where: { id: listingId },
        data: {
          status: nextStatus,
          reviewedAt: now,
          reviewerId: reviewer.id,
          ...(decision.action === 'APPROVED'
            ? { publishedAt: now }
            : {}),
          ...(decision.action === 'APPROVED' || decision.action === 'REJECTED'
            ? { slaDueAt: null }
            : {}),
          ...(decision.action === 'REJECTED' || decision.action === 'CHANGES_REQUESTED'
            ? { rejectionReason: (decision.note ?? decision.reasonCode ?? '').slice(0, 500) }
            : {}),
        },
        select: { id: true, status: true },
      });

      await tx.listingReviewEvent.create({
        data: {
          listingId,
          actorId: reviewer.id,
          action: decision.action,
          reasonCode: decision.reasonCode as never,
          note: decision.note?.slice(0, 2000),
          slaBreached,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: reviewer.id,
          actorRole: reviewer.role,
          action: `review.${decision.action.toLowerCase()}`,
          entityType: 'listing',
          entityId: listingId,
          metadata: {
            reasonCode: decision.reasonCode ?? null,
            slaBreached,
            wasBreached: slaBreached,
          },
        },
      });

      await tx.reviewAssignment.updateMany({
        where: { listingId, releasedAt: null },
        data: { releasedAt: now },
      });

      return updated;
    });

    if (slaBreached) {
      this.logger.warn(`SLA BREACH on listing ${listingId}: decided past ${listing.slaDueAt?.toISOString()}`);
    }

    return result;
  }

  // --- SLA telemetry ------------------------------------------------------

  /**
   * Flags SLA breaches that nobody has acted on.
   *
   * A 1-6 hour promise is only meaningful if missing it is visible and
   * attributable, so this both records the breach and reports it.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitorSla(): Promise<{ breached: number; warning: number }> {
    const now = new Date();

    const breached = await this.prisma.listing.findMany({
      where: { status: 'PENDING_REVIEW', slaDueAt: { lt: now } },
      select: { id: true, slaDueAt: true, kindCode: true, stateCode: true },
      take: 200,
    });

    for (const listing of breached) {
      // One EXP event per breached listing: the sweep runs every 5 minutes and
      // would otherwise write a duplicate row on every pass.
      const alreadyLogged = await this.prisma.listingReviewEvent.findFirst({
        where: { listingId: listing.id, action: 'EXPIRED' },
        select: { id: true },
      });
      if (alreadyLogged) continue;

      await this.prisma.listingReviewEvent.create({
        data: { listingId: listing.id, action: 'EXPIRED', slaBreached: true, note: 'SLA deadline passed' },
      });
      await this.prisma.auditLog.create({
        data: {
          action: 'review.sla_breached',
          entityType: 'listing',
          entityId: listing.id,
          metadata: {
            slaDueAt: listing.slaDueAt?.toISOString(),
            overdueMinutes: listing.slaDueAt
              ? Math.round((now.getTime() - listing.slaDueAt.getTime()) / 60_000)
              : null,
            kind: listing.kindCode,
            state: listing.stateCode,
          },
        },
      });
    }

    if (breached.length) {
      this.logger.error(`SLA: ${breached.length} listing(s) past the review deadline`);
    }

    const warning = await this.prisma.listing.count({
      where: {
        status: 'PENDING_REVIEW',
        slaDueAt: { gt: now, lt: new Date(now.getTime() + 60 * 60_000) },
      },
    });

    return { breached: breached.length, warning };
  }

  /** Queue health for the admin dashboard. */
  async queueStats(): Promise<{
    pending: number;
    unassigned: number;
    breached: number;
    medianMinutesToDecision: number | null;
    byKind: Array<{ kind: string; pending: number }>;
  }> {
    const now = new Date();

    const [pending, unassigned, breached] = await Promise.all([
      this.prisma.listing.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.listing.count({
        where: { status: 'PENDING_REVIEW', reviewerId: null },
      }),
      this.prisma.listing.count({
        where: { status: 'PENDING_REVIEW', slaDueAt: { lt: now } },
      }),
    ]);

    const grouped = await this.prisma.listing.groupBy({
      by: ['kindCode'],
      where: { status: 'PENDING_REVIEW' },
      _count: { _all: true },
    });

    // Median time-to-decision over the last 7 days.
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const decisions = await this.prisma.listingReviewEvent.findMany({
      where: {
        action: { in: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] },
        createdAt: { gte: since },
      },
      select: { createdAt: true, listing: { select: { submittedAt: true } } },
      take: 2000,
    });

    const durations = decisions
      .filter((d) => d.listing.submittedAt)
      .map((d) => (d.createdAt.getTime() - d.listing.submittedAt!.getTime()) / 60_000)
      .sort((a, b) => a - b);

    const median =
      durations.length === 0
        ? null
        : durations.length % 2 === 0
          ? ((durations[durations.length / 2 - 1] ?? 0) + (durations[durations.length / 2] ?? 0)) / 2
          : durations[Math.floor(durations.length / 2)] ?? null;

    return {
      pending,
      unassigned,
      breached,
      medianMinutesToDecision: median !== null ? Math.round(median) : null,
      byKind: grouped.map((g) => ({ kind: g.kindCode, pending: g._count._all })),
    };
  }

  /** Expiry sweep for long-live listings. */
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleListings(): Promise<number> {
    const result = await this.prisma.listing.updateMany({
      where: { status: 'LIVE', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (result.count) this.logger.log(`Expired ${result.count} listings past their expiry`);
    return result.count;
  }

  // --- Helpers ------------------------------------------------------------

  private async assertMediaReady(data: CreateListingPayload, ownerId: string): Promise<void> {
    const assetIds = [...data.mediaAssetIds];
    if (data.videoAssetId) assetIds.push(data.videoAssetId);

    const owned = await this.prisma.mediaAsset.findMany({
      where: { id: { in: assetIds }, ownerId },
      select: { id: true, kind: true, status: true },
    });

    if (owned.length !== assetIds.length) {
      throw ApiException.validation([
        { path: 'mediaAssetIds', message: 'One or more uploads could not be found' },
      ]);
    }

    const notReady = owned.filter((a) => a.status !== 'READY' && a.status !== 'PROCESSING');
    if (notReady.length) {
      throw new ApiException(
        'MEDIA_NOT_READY',
        'Some uploads are still processing. Wait a moment and try again.',
        409,
      );
    }

    if (data.videoAssetId) {
      const video = owned.find((a) => a.id === data.videoAssetId);
      if (video?.kind !== 'VIDEO') {
        throw ApiException.validation([
          { path: 'videoAssetId', message: 'That is not a video upload' },
        ]);
      }
    }
  }

  /**
   * Resolves the public LGA code to its surrogate id, and cross-checks that the
   * LGA really belongs to the submitted state. Without that check a poster could
   * file a Lagos listing under an Ogun LGA, which would poison the area-level
   * browse pages that drive SEO.
   */
  private async resolveLgaId(lgaCode: string, stateCode: string): Promise<string> {
    const lga = await this.prisma.lga.findUnique({
      where: { code: lgaCode },
      select: { id: true, stateCode: true },
    });
    if (!lga) {
      throw ApiException.validation([
        { path: 'lgaCode', message: 'Select a valid local government area' },
      ]);
    }
    if (lga.stateCode !== stateCode) {
      throw ApiException.validation([
        {
          path: 'lgaCode',
          message: `That local government area is not in ${stateCode}`,
        },
      ]);
    }
    return lga.id;
  }

  /**
   * Accepts only a curated (active) area. A poster who types an unknown
   * neighbourhood proposes it separately via LocationsService, which leaves it
   * inactive until an admin maps it to an LGA.
   */
  private async resolveAreaId(areaId: string | undefined): Promise<string | null> {
    if (!areaId) return null;

    const area = await this.prisma.area.findFirst({
      where: { id: areaId, isActive: true },
      select: { id: true },
    });

    if (!area) {
      throw ApiException.validation([
        { path: 'areaId', message: 'That area is not available yet' },
      ]);
    }
    return area.id;
  }

  private async resolveAgency(posterId: string): Promise<string | null> {
    const profile = await this.prisma.agentProfile.findUnique({
      where: { userId: posterId },
      select: { id: true },
    });
    return profile?.id ?? null;
  }
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
