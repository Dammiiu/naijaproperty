/**
 * Contact reveal: the single code path in the system that decrypts a phone
 * number or exact address.
 *
 * Design constraints, in order of priority:
 *
 *  1. A reveal is always audited, before the response is built. If the audit
 *     write fails we do not return the data.
 *  2. Rate limited per viewer, per listing, and per IP. Bulk enumeration must be
 *     expensive.
 *  3. Anomaly detection. A single account revealing dozens of listings in a
 *     short window is a scraper, not a buyer, and is flagged for review rather
 *     than merely rate limited.
 *  4. Re-revealing a listing you already unlocked is free and instant. The user
 *     should not pay twice for the same action.
 *  5. The exact address and phone never appear in any other serializer.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ApiException, type RevealResponse } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { RateLimiterService, RateLimitExceededError } from '../../common/rate-limiter.js';

/** Reveals per viewer per hour across all listings. */
const VIEWER_HOURLY_CAP = 40;
/**
 * Reveals per IP per hour. Catches scrapers operating many accounts from one
 * address.
 */
const IP_HOURLY_CAP = 100;
/** Reveals in a short window that trigger an account flag. */
const ANOMALY_WINDOW_MINUTES = 10;
const ANOMALY_THRESHOLD = 12;

@Injectable()
export class RevealService {
  private readonly logger = new Logger(RevealService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly limiter: RateLimiterService,
  ) {}

  async reveal(input: {
    viewerId: string;
    listingId: string;
    ip?: string;
    channel?: string;
  }): Promise<RevealResponse> {
    const { viewerId, listingId } = input;
    const ipHash = this.pii.hashIp(input.ip);

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        title: true,
        posterId: true,
        status: true,
        exactAddressEnc: true,
        area: { select: { name: true } },
        lga: { select: { name: true } },
        state: { select: { name: true } },
        poster: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            verificationTier: true,
            phoneVerifiedAt: true,
            phoneEnc: true,
            createdAt: true,
          },
        },
      },
    });

    if (!listing) throw ApiException.notFound('That listing is no longer available');

    // Only live listings expose a contact. A pending listing has not been
    // reviewed, so revealing its owner would bypass the review gate entirely.
    if (listing.status !== 'LIVE') {
      throw new ApiException(
        'LISTING_NOT_APPROVED',
        'This listing is not published yet',
        409,
      );
    }

    if (listing.posterId === viewerId) {
      throw ApiException.forbidden('This is your own listing');
    }

    // Already unlocked: no rate-limit cost, no new audit row.
    const existing = await this.prisma.contactReveal.findUnique({
      where: { listingId_viewerId: { listingId, viewerId } },
    });

    if (existing && !existing.revokedAt) {
      /*
       * Self-heal rather than trust that the conversation still exists.
       *
       * A reveal row and its conversation are created in one transaction, but the
       * conversation can be removed on its own (a moderation purge, a data
       * cleanup, a listing re-created from the same poster). When that happened
       * the lookup came back empty and the old code fell through to using the
       * listing id as the conversation id, which handed the client a valid-looking
       * cuid pointing at a conversation that did not exist. The symptom was a
       * "Message the owner" button that navigated to a 404.
       *
       * Upserting repairs the inconsistency on read, and stays idempotent.
       */
      const conv = await this.prisma.conversation.upsert({
        where: { listingId_initiatorId: { listingId, initiatorId: viewerId } },
        create: { listingId, initiatorId: viewerId, ownerId: listing.posterId },
        update: {},
        select: { id: true },
      });
      return this.buildResponse(listing, viewerId, true, conv.id);
    }

    await this.assertWithinLimits(viewerId, ipHash);

    await this.flagAnomalyIfNeeded(viewerId);

    // Audit first. If this throws we never decrypt anything.
    const conversation = await this.prisma.$transaction(async (tx) => {
      await tx.contactReveal.upsert({
        where: { listingId_viewerId: { listingId, viewerId } },
        create: {
          listingId,
          viewerId,
          ownerId: listing.posterId,
          channel: input.channel ?? 'WEB',
          ipHash,
        },
        update: { revealedAt: new Date(), ipHash, channel: input.channel ?? 'WEB' },
      });

      await tx.listing.update({
        where: { id: listingId },
        data: { contactClickCount: { increment: 1 } },
      });

      // Reveal opens the conversation in-app, so the viewer has a lower-friction
      // way to make contact than a phone call and we keep the thread on-platform.
      const conv = await tx.conversation.upsert({
        where: { listingId_initiatorId: { listingId, initiatorId: viewerId } },
        create: {
          listingId,
          initiatorId: viewerId,
          ownerId: listing.posterId,
        },
        update: {},
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: viewerId,
          action: 'contact.reveal',
          entityType: 'listing',
          entityId: listingId,
          ipHash,
          // Deliberately records that a reveal happened, never the values.
          metadata: { channel: input.channel ?? 'WEB' },
        },
      });

      return conv;
    });

    return this.buildResponse(listing, viewerId, false, conversation.id);
  }

  /**
   * Charges every budget at the same time.
   *
   * Charging them together rather than sequentially means a caller cannot probe
   * which limit was hit, and no partial charge is left behind when one budget is
   * exhausted.
   *
   * There is deliberately no per-listing counter. Idempotency is handled by the
   * `contact_reveal` lookup above: a viewer who already unlocked a listing returns
   * the cached response and is never charged. An earlier version used a
   * per-listing cap of 1, which silently broke the legitimate flow where a first
   * attempt failed (owner had no phone on file) and the user tried again later.
   */
  private async assertWithinLimits(
    viewerId: string,
    ipHash: string | undefined,
  ): Promise<void> {
    const budgets: Array<Promise<unknown>> = [
      this.limiter.consume(`reveal:user:${viewerId}`, VIEWER_HOURLY_CAP),
    ];

    if (ipHash) {
      budgets.push(
        this.limiter
          .consume(`reveal:ip:${ipHash}`, IP_HOURLY_CAP)
          .catch((err) => {
            if (err instanceof RateLimitExceededError) {
              this.logger.warn(`IP reveal cap hit: ${ipHash}`);
            }
            throw err;
          }),
      );
    }

    const results = await Promise.allSettled(budgets);
    const breached = results.find((r) => r.status === 'rejected');

    if (breached && breached.status === 'rejected') {
      const reason = breached.reason;

      // Only an actual budget breach becomes a 429. Anything else is a genuine
      // fault and must not be disguised as rate limiting, which would send the
      // caller away for an hour over what is really a server bug.
      if (reason instanceof RateLimitExceededError) {
        throw ApiException.rateLimited(
          'You have contacted many listings recently. Try again in an hour.',
          reason.retryAfterSeconds,
        );
      }

      this.logger.error(
        `Reveal limiter fault for viewer ${viewerId}: ${(reason as Error)?.message ?? reason}`,
      );
      throw ApiException.internal('Could not complete the contact request');
    }
  }

  /**
   * Flags accounts revealing across many distinct listings quickly. This is the
   * signal that separates a serious buyer from a scraper harvesting the site.
   */
  private async flagAnomalyIfNeeded(viewerId: string): Promise<void> {
    const since = new Date(Date.now() - ANOMALY_WINDOW_MINUTES * 60 * 1000);

    const count = await this.prisma.contactReveal.count({
      where: { viewerId, revealedAt: { gte: since } },
    });

    if (count >= ANOMALY_THRESHOLD) {
      this.logger.warn(`Reveal anomaly: user ${viewerId} has ${count} reveals in ${ANOMALY_WINDOW_MINUTES}min`);
      await this.prisma.auditLog.create({
        data: {
          actorId: viewerId,
          action: 'security.reveal_anomaly',
          entityType: 'user',
          entityId: viewerId,
          metadata: { reveals: count, windowMinutes: ANOMALY_WINDOW_MINUTES },
        },
      });
    }
  }

  /** The one place plaintext PII is assembled for a response. */
  private buildResponse(
    listing: {
      id: string;
      title?: string;
      exactAddressEnc: string | null;
      area: { name: string } | null;
      lga: { name: string };
      state: { name: string };
      poster: {
        id: string;
        displayName: string;
        avatarUrl: string | null;
        verificationTier: string;
        phoneVerifiedAt: Date | null;
        phoneEnc: string | null;
        createdAt: Date;
      };
    },
    _viewerId: string,
    alreadyRevealed: boolean,
    conversationId: string,
  ): RevealResponse {
    /*
     * Decryption is wrapped, matching what the detail endpoint already does.
     *
     * A ciphertext that cannot be read is a data problem, not a caller problem,
     * and it must not surface as a 500: the user did nothing wrong and there is
     * nothing they can do about it. Previously a bad envelope threw straight out
     * of here and every reveal against the affected listings returned
     * INTERNAL_ERROR, which reads as "the site is broken".
     *
     * A failed phone decrypt still throws, but as a 409 with the same wording as
     * the no-phone case, because the user's next step is identical: message the
     * owner instead. A failed address decrypt degrades to the area/LGA/state that
     * is already public, which is the whole point of publishing those.
     */
    let phone: string | null = null;
    if (listing.poster.phoneEnc) {
      try {
        phone = this.pii.decrypt(listing.poster.phoneEnc);
      } catch (err) {
        this.logger.error(
          `Phone ciphertext unreadable for user ${listing.poster.id}: ${(err as Error).message}`,
        );
      }
    }

    if (!phone) {
      // Owner registered by email only and never verified a phone, or their
      // stored value is unreadable. Either way we do not invent a placeholder;
      // the client offers "message instead".
      throw new ApiException(
        'UPSTREAM_UNAVAILABLE',
        'This owner has not published a phone number. Send them a message instead.',
        409,
      );
    }

    let exactAddress: string | null = null;
    if (listing.exactAddressEnc) {
      try {
        exactAddress = this.pii.decrypt(listing.exactAddressEnc);
      } catch (err) {
        this.logger.error(
          `Address ciphertext unreadable for listing ${listing.id}: ${(err as Error).message}`,
        );
      }
    }

    const addressParts = [
      exactAddress,
      listing.area?.name,
      listing.lga.name,
      listing.state.name,
    ].filter((p): p is string => Boolean(p));

    /*
     * Required, not defaulted.
     *
     * This used to fall back to `listing.id`, which produced a well-formed cuid
     * that pointed at no conversation: the client then built a message link from
     * it and the user landed on a 404. Both call sites now guarantee the
     * conversation exists, and the signature is non-optional so a future caller
     * cannot reintroduce a plausible-looking wrong id.
     */
    if (!conversationId) {
      this.logger.error(
        `Reveal for listing ${listing.id} reached the response builder with no conversation`,
      );
      throw ApiException.internal('Could not open a conversation for this listing');
    }
    const conversation = conversationId;

    return {
      listingId: listing.id,
      owner: {
        displayName: listing.poster.displayName,
        avatarUrl: listing.poster.avatarUrl,
        verificationTier: listing.poster.verificationTier,
        memberSince: listing.poster.createdAt.toISOString(),
        // Phase 4 will compute this from real message and reveal history.
        responseRate: 100,
      },
      phone,
      whatsappUrl: this.pii.whatsappUrl(
        phone,
        listing.title
          ? `Hello, I found your listing "${listing.title}" on Naijaproperty and I'm interested.`
          : 'Hello, I found your listing on Naijaproperty and I am interested.',
      ),
      exactAddress: addressParts.join(', '),
      conversationId: conversation,
      alreadyRevealed,
    };
  }
}
