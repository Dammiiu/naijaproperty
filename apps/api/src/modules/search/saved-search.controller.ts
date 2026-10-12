/**
 * Saved searches.
 *
 * A saved search is a named, re-runnable filter, not a bookmark of listings. That
 * distinction matters in this market: a landlord re-lists, an agent re-uploads,
 * and a saved-search query finds the new listing while a favourites list shows a
 * dead card. It is also why this is worth building before chat.
 *
 * `queryJson` stores the search parameters verbatim rather than a normalised
 * column set. Filters change as the product grows, and re-migrating a row for
 * every new filter is not worth it when the whole value is "run this query again".
 * It is re-validated against the live contract on every run, so a stale shape
 * fails loudly rather than silently returning nothing.
 */

import {
  Body,
  Controller,
  Delete,
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
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiException, searchQuerySchema } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';

@ApiTags('saved-searches')
@Controller('saved-searches')
@UseGuards(JwtAuthGuard)
export class SavedSearchController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The signed-in user saved searches' })
  async list(@Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const searches = await this.prisma.savedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { matches: true } } },
    });

    return {
      items: searches.map((s) => ({
        id: s.id,
        name: s.name,
        query: s.queryJson,
        cadence: s.cadence,
        notifyChannels: s.notifyChannels,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        // How many listings matched last time this ran. "12 new" is the reason
        // anyone keeps a saved search, so the count belongs on the list row.
        newMatches: s._count.matches,
      })),
    };
  }

  /**
   * Creates a saved search.
   *
   * The query is validated against the live search contract here rather than
   * trusted, because it is replayed later by a cron job. A hand-crafted query
   * that would be rejected by the search endpoint must not be storable, or the
   * failure surfaces at 3am in a scheduler instead of at the moment of saving.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Save the current search' })
  async create(@Body() body: unknown, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80),
        query: z.unknown(),
      })
      .safeParse(body);

    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const query = searchQuerySchema.safeParse(parsed.data.query);
    if (!query.success) {
      throw ApiException.validation(
        query.error.issues.map((i: { path: (string | number)[]; message: string }) => ({ path: `query.${i.path.join('.')}`, message: i.message })),
      );
    }

    // A name the user would not recognise is worse than no name, so derive one
    // when they did not supply it.
    const name =
      parsed.data.name ||
      this.describe(query.data) ||
      `${query.data.kind === 'SALE' ? 'For sale' : 'To rent'} search`;

    const search = await this.prisma.savedSearch.create({
      data: {
        userId,
        name,
        queryJson: query.data as object,
      },
      select: { id: true, name: true, queryJson: true, createdAt: true },
    });

    return search;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or re-cadence a saved search' })
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const patch = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        cadence: z.enum(['INSTANT', 'DAILY', 'WEEKLY']).optional(),
      })
      .safeParse(body);

    if (!patch.success) {
      throw ApiException.validation(
        patch.error.issues.map((i: { path: (string | number)[]; message: string }) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    // Scoped to the owner, so a guessed id cannot touch someone else's row.
    const result = await this.prisma.savedSearch.updateMany({
      where: { id, userId },
      data: {
        ...(patch.data.name ? { name: patch.data.name } : {}),
        ...(patch.data.cadence ? { cadence: patch.data.cadence } : {}),
      },
    });

    if (result.count === 0) throw ApiException.notFound('Saved search not found');
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a saved search' })
  async remove(@Param('id') id: string, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const result = await this.prisma.savedSearch.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw ApiException.notFound('Saved search not found');
  }

  /**
   * New matches for one saved search.
   *
   * Runs the saved query and reports only listings it has not seen before, then
   * records them. Without that, "new" would mean "everything", and the count
   * that justifies keeping a search would be meaningless.
   */
  @Get(':id/matches')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Listings that matched since the last run' })
  async matches(@Param('id') id: string, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const search = await this.prisma.savedSearch.findFirst({
      where: { id, userId },
      select: { id: true, queryJson: true, matches: { select: { listingId: true } } },
    });
    if (!search) throw ApiException.notFound('Saved search not found');

    const query = searchQuerySchema.parse(search.queryJson);
    const seenIds = search.matches.map((m) => m.listingId);

    const listings = await this.prisma.listing.findMany({
      where: {
        kindCode: query.kind,
        status: 'LIVE',
        id: { notIn: seenIds },
        ...(query.stateCode?.length ? { stateCode: { in: query.stateCode } } : {}),
        ...(query.minPrice !== undefined || query.maxPrice !== undefined
          ? {
              price: {
                ...(query.minPrice !== undefined ? { gte: BigInt(query.minPrice) } : {}),
                ...(query.maxPrice !== undefined ? { lte: BigInt(query.maxPrice) } : {}),
              },
            }
          : {}),
        ...(query.bedroomsMin !== undefined ? { bedrooms: { gte: query.bedroomsMin } } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: 50,
      include: {
        state: { select: { name: true } },
        lga: { select: { name: true } },
        area: { select: { name: true } },
        type: { select: { label: true } },
      },
    });

    // Recorded so the next run can tell genuinely new listings from ones already
    // reported.
    if (listings.length > 0) {
      await this.prisma.savedSearchMatch.createMany({
        data: listings.map((l) => ({ savedSearchId: search.id, listingId: l.id })),
        skipDuplicates: true,
      });
      await this.prisma.savedSearch.update({
        where: { id: search.id },
        data: { lastRunAt: new Date() },
      });
    }

    return {
      items: listings.map((l) => ({
        id: l.id,
        title: l.title,
        typeLabel: l.type.label,
        price: Number(l.price),
        pricePeriod: l.pricePeriod,
        location: {
          areaName: l.area?.name ?? null,
          lgaName: l.lga.name,
          stateName: l.state.name,
        },
        publishedAt: l.publishedAt?.toISOString() ?? null,
      })),
    };
  }

  private userId(req: FastifyRequest): string {
    const sub = (req as AuthenticatedRequest).user?.sub;
    if (!sub) throw ApiException.unauthenticated();
    return sub;
  }

  /** Builds a human name for a query, so saved searches are findable in a list. */
  private describe(q: z.infer<typeof searchQuerySchema>): string | null {
    const parts: string[] = [];
    if (q.q) parts.push(`"${q.q}"`);
    if (q.type?.length) parts.push(q.type.join(', '));
    if (q.stateCode?.length) parts.push(q.stateCode.join(', '));
    if (q.minPrice || q.maxPrice) {
      parts.push(`${q.minPrice ?? 0} to ${q.maxPrice ?? 'any'}`);
    }
    if (q.bedroomsMin) parts.push(`${q.bedroomsMin}+ bed`);
    return parts.length ? parts.join(', ') : null;
  }
}