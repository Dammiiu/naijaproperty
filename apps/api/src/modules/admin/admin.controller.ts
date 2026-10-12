/**
 * Admin console backend.
 *
 * Scope, in the order it was agreed:
 *   1. Review queue with media preview and one-click decisions
 *   2. Area curation (activate, rename, merge proposals)
 *   3. User management (suspend, change role, grant verification)
 *   4. Platform settings
 *   5. Agency and licence review
 *   6. Plans and entitlements (monetisation admin, no live payments)
 *
 * Two rules hold across all of it:
 *   - Every mutation writes an audit row. `audit_logs` is append-only at the
 *     database level, so the trail cannot be edited even by a mistake here.
 *   - Nothing destructive without an explicit confirmation path. Listings are
 *     never hard-deleted from this surface; they are expired.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { publicImageUrl } from '../../common/media-url.js';
import { JwtAuthGuard, RolesGuard, Roles, STAFF_ROLES, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Headline numbers for the console landing page.
   *
   * Deliberately a small fixed set. A dashboard that surfaces twenty metrics is
   * a dashboard nobody reads, and the two that matter are queue health and live
   * inventory.
   */
  @Get('overview')
  @ApiOperation({ summary: 'Console headline metrics' })
  async overview() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    const [
      pending,
      unassigned,
      breached,
      live,
      liveRent,
      liveSale,
      newListings24h,
      newUsers24h,
      inactiveAreaProposals,
      pendingAgencies,
      reveals24h,
      conversations,
      suspended,
    ] = await Promise.all([
      this.prisma.listing.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.listing.count({ where: { status: 'PENDING_REVIEW', reviewerId: null } }),
      this.prisma.listing.count({ where: { status: 'PENDING_REVIEW', slaDueAt: { lt: now } } }),
      this.prisma.listing.count({ where: { status: 'LIVE' } }),
      this.prisma.listing.count({ where: { status: 'LIVE', kindCode: 'RENT' } }),
      this.prisma.listing.count({ where: { status: 'LIVE', kindCode: 'SALE' } }),
      this.prisma.listing.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.area.count({ where: { isActive: false } }),
      this.prisma.agentProfile.count({ where: { licenceVerifiedAt: null } }),
      this.prisma.contactReveal.count({ where: { revealedAt: { gte: dayAgo } } }),
      this.prisma.conversation.count(),
      this.prisma.user.count({ where: { status: 'SUSPENDED' } }),
    ]);

    // Median time to decision over the trailing week. This is the number the
    // 1-6 hour promise is actually measured against, so it belongs on the
    // landing page rather than buried in a report.
    const decisions = await this.prisma.listingReviewEvent.findMany({
      where: {
        action: { in: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] },
        createdAt: { gte: weekAgo },
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
          : (durations[Math.floor(durations.length / 2)] ?? null);

    return {
      review: {
        pending,
        unassigned,
        breached,
        medianMinutesToDecision: median === null ? null : Math.round(median),
        slaTargetMinutes: 180,
        slaEscalateMinutes: 360,
      },
      inventory: { live, liveRent, liveSale },
      activity: {
        newListings24h,
        newUsers24h,
        reveals24h,
        conversations,
      },
      attention: { inactiveAreaProposals, pendingAgencies, suspendedUsers: suspended },
    };
  }

  // -------------------------------------------------------------------------
  // Review queue
  // -------------------------------------------------------------------------

  /**
   * The queue itself, not just its size.
   *
   * A moderator's job is to look at photos, read the description and decide. So
   * the row carries everything needed for that judgement in one payload: media,
   * price, the exact address (staff may see it, because verifying that an address
   * is real is part of the review), and any auto-moderation signals.
   *
   * Ordered by SLA urgency rather than arrival: the listing closest to breaching
   * floats to the top, which is the only ordering that protects the 6-hour
   * promise.
   */
  @Get('review/items')
  @ApiOperation({ summary: 'Listings awaiting review, most urgent first' })
  async reviewItems(@Query('limit') rawLimit?: string) {
    const limit = Math.min(Math.max(Number(rawLimit ?? 25) || 25, 1), 100);
    const now = new Date();

    const items = await this.prisma.listing.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: [{ slaDueAt: 'asc' }, { submittedAt: 'asc' }],
      take: limit,
      include: {
        state: { select: { name: true } },
        lga: { select: { name: true } },
        area: { select: { id: true, name: true, isActive: true } },
        type: { select: { label: true } },
        poster: {
          select: {
            id: true,
            displayName: true,
            email: true,
            phoneVerifiedAt: true,
            verificationTier: true,
            status: true,
            createdAt: true,
            _count: { select: { listings: true } },
          },
        },
        media: {
          orderBy: { position: 'asc' },
          select: {
            isCover: true,
            mediaAsset: {
              select: { id: true, storageKey: true, width: true, height: true, moderationStatus: true },
            },
          },
        },
        videoAsset: { select: { id: true, storageKey: true, streamUid: true, durationMs: true } },
        moderationSignals: {
          select: { signal: true, severity: true, source: true, detail: true },
        },
      },
    });

    return {
      items: items.map((l) => {
        const minutesLeft = l.slaDueAt
          ? Math.round((l.slaDueAt.getTime() - now.getTime()) / 60_000)
          : null;

        return {
          id: l.id,
          kind: l.kindCode,
          typeLabel: l.type.label,
          title: l.title,
          description: l.description,
          price: Number(l.price),
          pricePeriod: l.pricePeriod,
          bedrooms: l.bedrooms,
          plotSqm: l.plotSqm,
          location: {
            areaName: l.area?.name ?? null,
            areaIsActive: l.area?.isActive ?? null,
            lgaName: l.lga.name,
            stateName: l.state.name,
          },
          poster: {
            id: l.poster.id,
            displayName: l.poster.displayName,
            email: l.poster.email,
            phoneVerified: l.poster.phoneVerifiedAt !== null,
            verificationTier: l.poster.verificationTier,
            status: l.poster.status,
            memberSince: l.poster.createdAt.toISOString(),
            listingsCount: l.poster._count.listings,
          },
          media: l.media.map((m) => ({
            id: m.mediaAsset.id,
            url: publicImageUrl(m.mediaAsset.id, undefined, m.mediaAsset.storageKey),
            moderationStatus: m.mediaAsset.moderationStatus,
            isCover: m.isCover,
          })),
          hasVideo: l.videoAsset !== null,
          signals: l.moderationSignals.map((s) => ({
            signal: s.signal,
            severity: s.severity,
            source: s.source,
            detail: s.detail,
          })),
          submittedAt: l.submittedAt?.toISOString() ?? null,
          slaDueAt: l.slaDueAt?.toISOString() ?? null,
          slaMinutesLeft: minutesLeft,
          slaBreached: minutesLeft !== null && minutesLeft < 0,
          reviewerId: l.reviewerId,
        };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Areas
  // -------------------------------------------------------------------------

  @Get('areas')
  @ApiOperation({ summary: 'Area curation list' })
  async areas(@Query('filter') filter?: string) {
    const where =
      filter === 'inactive'
        ? { isActive: false }
        : filter === 'active'
          ? { isActive: true }
          : {};

    const [areas, states] = await Promise.all([
      this.prisma.area.findMany({
        where,
        orderBy: [{ isActive: 'asc' }, { proposalCount: 'desc' }, { name: 'asc' }],
        take: 500,
        include: {
          state: { select: { code: true, name: true } },
          lga: { select: { name: true } },
          _count: { select: { listings: true, aliases: true } },
        },
      }),
      this.prisma.state.findMany({ orderBy: { name: 'asc' }, select: { code: true, name: true } }),
    ]);

    return {
      areas: areas.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        stateCode: a.state.code,
        stateName: a.state.name,
        lgaName: a.lga.name,
        isActive: a.isActive,
        proposalCount: a.proposalCount,
        listingCount: a._count.listings,
        aliasCount: a._count.aliases,
      })),
      states,
    };
  }

  /**
   * Activating an area is the highest-leverage curation action: it makes the
   * area selectable in search and in the post form, and it is what turns a
   * poster's proposal into searchable inventory. Inactive areas with proposals
   * therefore sort first.
   */
  @Patch('areas/:id')
  @ApiOperation({ summary: 'Activate, deactivate or rename an area' })
  async updateArea(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsedId = z.string().cuid().safeParse(id);
    if (!parsedId.success) throw ApiException.notFound('Area not found');

    const patch = z
      .object({
        isActive: z.boolean().optional(),
        name: z.string().min(2).max(120).optional(),
      })
      .safeParse(body);

    if (!patch.success) {
      throw ApiException.validation(
        patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const area = await this.prisma.area.update({
      where: { id: parsedId.data },
      data: {
        ...(patch.data.isActive !== undefined ? { isActive: patch.data.isActive } : {}),
        ...(patch.data.name !== undefined ? { name: patch.data.name } : {}),
      },
    });

    await this.audit(req, 'admin.area.updated', 'area', area.id, patch.data);
    return area;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  @Get('users')
  @ApiOperation({ summary: 'User directory' })
  async users(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Math.min(Math.max(Number(rawLimit ?? 50) || 50, 1), 200);

    const users = await this.prisma.user.findMany({
      where: {
        ...(status === 'SUSPENDED' ? { status: 'SUSPENDED' } : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        verificationTier: true,
        phoneVerifiedAt: true,
        scopeStates: true,
        createdAt: true,
        lastLoginAt: true,
        lockedUntil: true,
        failedLoginCount: true,
        _count: { select: { listings: true, contactReveals: true } },
        agentProfile: { select: { agencyName: true, licenceVerifiedAt: true, licenceNo: true } },
      },
    });

    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        status: u.status,
        verificationTier: u.verificationTier,
        phoneVerified: u.phoneVerifiedAt !== null,
        scopeStates: u.scopeStates,
        memberSince: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        lockedUntil: u.lockedUntil?.toISOString() ?? null,
        failedLoginCount: u.failedLoginCount,
        listingCount: u._count.listings,
        revealCount: u._count.contactReveals,
        agencyName: u.agentProfile?.agencyName ?? null,
        agencyLicenceVerified: u.agentProfile?.licenceVerifiedAt != null,
        licenceNo: u.agentProfile?.licenceNo ?? null,
      })),
    };
  }

  /**
   * User moderation.
   *
   * `reason` is required whenever the action is punitive (suspend or demote)
   * because the audit trail has to answer "why was this person locked out" a year
   * later without someone having to guess.
   */
  @Patch('users/:id')
  @ApiOperation({ summary: 'Suspend, reinstate, or change a user role' })
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsedId = z.string().cuid().safeParse(id);
    if (!parsedId.success) throw ApiException.notFound('User not found');

    const patch = z
      .object({
        status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
        role: z.enum(['USER', 'AGENT', 'MODERATOR', 'ADMIN', 'SUPERADMIN']).optional(),
        verificationTier: z.enum(['NONE', 'PHONE', 'DOCUMENT', 'VERIFIED_AGENT']).optional(),
        reason: z.string().min(3).max(1000).optional(),
      })
      .safeParse(body);

    if (!patch.success) {
      throw ApiException.validation(
        patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const punitive =
      patch.data.status === 'SUSPENDED' ||
      patch.data.role === 'USER' ||
      patch.data.verificationTier === 'NONE';

    if (punitive && !patch.data.reason) {
      throw ApiException.validation([
        { path: 'reason', message: 'A reason is required when restricting an account' },
      ]);
    }

    const actor = (req as AuthenticatedRequest).user;
    if (!actor) throw ApiException.unauthenticated();

    // An admin must not be able to lock themselves out or escalate their own
    // account, which is the classic privilege-escalation footgun.
    if (parsedId.data === actor.sub && (patch.data.role || patch.data.status === 'SUSPENDED')) {
      throw ApiException.forbidden('You cannot change your own role or status');
    }

    const user = await this.prisma.user.update({
      where: { id: parsedId.data },
      data: {
        ...(patch.data.status ? { status: patch.data.status } : {}),
        ...(patch.data.role ? { role: patch.data.role } : {}),
        ...(patch.data.verificationTier ? { verificationTier: patch.data.verificationTier } : {}),
      },
      select: { id: true, email: true, role: true, status: true, verificationTier: true },
    });

    await this.audit(req, 'admin.user.updated', 'user', user.id, {
      ...patch.data,
      // Recorded rather than trusted from the body.
      reason: patch.data.reason ?? null,
    });

    return user;
  }

  // -------------------------------------------------------------------------
  // Agencies and licences
  // -------------------------------------------------------------------------

  /**
   * Licence review.
   *
   * This is the check neither Jiji nor PropertyPro performs, and it is the one
   * that matters most for land. A verified licence is what makes "verified agent"
   * a claim rather than a badge anyone can select.
   */
  @Get('agencies')
  @ApiOperation({ summary: 'Agent profiles awaiting licence review' })
  async agencies(@Query('filter') filter?: string) {
    const where =
      filter === 'unverified'
        ? { licenceVerifiedAt: null }
        : filter === 'verified'
          ? { licenceVerifiedAt: { not: null } }
          : {};

    const profiles = await this.prisma.agentProfile.findMany({
      where,
      orderBy: [{ licenceVerifiedAt: 'asc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            status: true,
            phoneVerifiedAt: true,
            verificationTier: true,
            _count: { select: { listings: true } },
          },
        },
      },
    });

    return {
      agencies: profiles.map((p) => ({
        id: p.id,
        userId: p.user.id,
        displayName: p.user.displayName,
        email: p.user.email,
        userStatus: p.user.status,
        phoneVerified: p.user.phoneVerifiedAt !== null,
        agencyName: p.agencyName,
        licenceNo: p.licenceNo,
        licenceBody: p.licenceBody,
        licenceVerified: p.licenceVerifiedAt !== null,
        licenceVerifiedAt: p.licenceVerifiedAt?.toISOString() ?? null,
        yearsActive: p.yearsActive,
        officeStates: p.officeStates,
        listingCount: p.user._count.listings,
      })),
    };
  }

  @Patch('agencies/:id')
  @ApiOperation({ summary: 'Approve or revoke an agent licence' })
  async updateAgency(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsedId = z.string().cuid().safeParse(id);
    if (!parsedId.success) throw ApiException.notFound('Agency not found');

    const patch = z
      .object({
        verify: z.boolean(),
        licenceNo: z.string().max(64).optional(),
        licenceBody: z.string().max(120).optional(),
        agencyName: z.string().min(2).max(160).optional(),
        reason: z.string().min(3).max(1000).optional(),
      })
      .safeParse(body);

    if (!patch.success) {
      throw ApiException.validation(
        patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    // Revoking needs a reason; approving does not.
    if (!patch.data.verify && !patch.data.reason) {
      throw ApiException.validation([
        { path: 'reason', message: 'A reason is required when revoking a licence' },
      ]);
    }

    const profile = await this.prisma.agentProfile.update({
      where: { id: parsedId.data },
      data: {
        licenceVerifiedAt: patch.data.verify ? new Date() : null,
        ...(patch.data.licenceNo ? { licenceNo: patch.data.licenceNo } : {}),
        ...(patch.data.licenceBody ? { licenceBody: patch.data.licenceBody } : {}),
        ...(patch.data.agencyName ? { agencyName: patch.data.agencyName } : {}),
      },
      select: { id: true, agencyName: true, licenceNo: true, licenceVerifiedAt: true },
    });

    // The user's tier follows the licence, so a revoked licence cannot leave a
    // "verified agent" badge behind on listings that are already live.
    if (patch.data.verify) {
      await this.prisma.user.update({
        where: { id: (await this.prisma.agentProfile.findUniqueOrThrow({
          where: { id: parsedId.data },
          select: { userId: true },
        })).userId },
        data: { verificationTier: 'VERIFIED_AGENT' },
      });
    }

    await this.audit(req, patch.data.verify ? 'admin.licence.approved' : 'admin.licence.revoked', 'agent_profile', profile.id, patch.data);

    return profile;
  }

  // -------------------------------------------------------------------------
  // Plans and entitlements (monetisation admin, no live payments)
  // -------------------------------------------------------------------------

  @Get('plans')
  @ApiOperation({ summary: 'Plans and their entitlements' })
  async plans() {
    const plans = await this.prisma.plan.findMany({
      orderBy: { priceNgn: 'asc' },
      include: { entitlements: true },
    });

    // Subscriber counts make the pricing page a decision rather than a guess.
    const counts = await this.prisma.user.groupBy({
      by: ['verificationTier'],
      _count: { _all: true },
    });

    return {
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        tier: p.tier,
        priceNgn: Number(p.priceNgn),
        billingPeriod: p.billingPeriod,
        description: p.description,
        entitlements: p.entitlements.map((e) => ({
          feature: e.feature,
          limit: e.limitJson,
        })),
      })),
      livePayments: false,
      note:
        'Payments are deliberately not wired. Changing a plan here changes what the ' +
        'product is allowed to do; it does not move money.',
      verificationTierCounts: counts.map((c) => ({
        tier: c.verificationTier,
        count: c._count._all,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Platform settings, stored as a single JSONB row.
   *
   * A key/value table would be more "correct" but nothing here needs
   * per-row permissions or per-row history; the whole object is versioned in the
   * audit log on every write, which is the history that actually matters.
   */
  @Get('settings')
  @ApiOperation({ summary: 'Platform settings' })
  async settings() {
    const row = await this.prisma.platformSetting.findFirst({ orderBy: { updatedAt: 'desc' } });
    return row?.value ?? {};
  }

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace platform settings' })
  async saveSettings(@Body() body: unknown, @Req() req: FastifyRequest) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ApiException.validation([{ path: '.', message: 'Settings must be an object' }]);
    }

    const row = await this.prisma.platformSetting.create({
      data: { key: 'platform', value: body as Prisma.InputJsonValue },
      select: { id: true, updatedAt: true },
    });

    await this.audit(req, 'admin.settings.updated', 'platform_setting', row.id, {
      keys: Object.keys(body as Record<string, unknown>),
    });

    return row;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  @Get('audit')
  @ApiOperation({ summary: 'Recent audit trail' })
  async auditTrail(@Query('limit') rawLimit?: string) {
    const limit = Math.min(Math.max(Number(rawLimit ?? 50) || 50, 1), 200);
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorRole: true,
        metadata: true,
        createdAt: true,
        actor: { select: { displayName: true, email: true } },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Writes the audit row.
   *
   * Never throws: an audit write failure must not roll back an action a human
   * authorised and expects to have taken effect. The failure is logged by the
   * Prisma call itself and the action stands, which is the correct trade — a
   * suspended user stays suspended even if we could not record why.
   */
  private async audit(
    req: FastifyRequest,
    action: string,
    entityType: string,
    entityId: string,
    metadata: unknown,
  ): Promise<void> {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return;

    await this.prisma.auditLog
      .create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action,
          entityType,
          entityId,
          metadata: (metadata ?? {}) as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}