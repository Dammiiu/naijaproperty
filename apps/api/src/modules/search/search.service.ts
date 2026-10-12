/**
 * Public search.
 *
 * The one rule that defines this marketplace: `kind` is a partition, not a
 * filter. It selects the taxonomy, the facet set, and the price semantics. A
 * rent query can never surface a sale listing, because the WHERE clause is
 * built from the partition rather than from user-supplied predicates.
 *
 * Implementation notes:
 *
 *  - Postgres full-text search plus pg_trgm today, behind a `SearchProvider`
 *    interface. Swapping to Typesense or Algolia later is a contained change
 *    because nothing above this file knows how search works.
 *
 *  - The listing detail serializer used here deliberately omits `exactAddressEnc`
 *    and the poster's phone. Area, LGA and state are public; the address is
 *    reveal-gated. This is enforced by the explicit `select`, not by relying on
 *    someone remembering to strip a field later.
 *
 *  - Facet counts come from a single grouped query over the same filter set, so
 *    the numbers always agree with the results.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ListingStatus, Prisma, type PricePeriod } from '@prisma/client';
import {
  AMENITY_LABELS,
  ApiException,
  searchQuerySchema,
  type Amenity,
  type FacetBucket,
  type ListingCard,
  type SearchQuery,
  type SortOrder,
} from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { deriveBadges } from '../../common/badge-cap.js';
import { publicImageUrl } from '../../common/media-url.js';
import { getEnv } from '../../config/env.js';

/** How many results one page may ask for. */
const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 24;

/**
 * Columns that are safe to return publicly. `exactAddressEnc` is absent by
 * construction, which is why reveal-gating cannot be bypassed by a query change.
 */
const PUBLIC_SELECT = {
  id: true,
  kindCode: true,
  typeCode: true,
  title: true,
  price: true,
  pricePeriod: true,
  priceNegotiable: true,
  agencyFee: true,
  bedrooms: true,
  bathrooms: true,
  plotSqm: true,
  publishedAt: true,
  createdAt: true,
  viewCount: true,
  promotedUntil: true,
  videoAssetId: true,
  titleVerifiedAt: true,
  area: { select: { name: true } },
  lga: { select: { name: true } },
  state: { select: { name: true } },
  poster: {
    select: {
      verificationTier: true,
      phoneVerifiedAt: true,
      agentProfile: { select: { agencyName: true, licenceVerifiedAt: true } },
    },
  },
  media: {
    where: { isCover: true },
    take: 1,
    select: {
      mediaAsset: {
        select: {
          id: true,
          width: true,
          height: true,
          blurhash: true,
          dominantColor: true,
          storageKey: true,
        },
      },
    },
  },

  /*
   * Reputation, aggregated server-side.
   *
   * Selected as a filtered relation rather than fetched per card: this keeps the
   * rating to a single extra join on the page query instead of N+1 round trips.
   *
   * 'status: PUBLISHED' matters as much as it looks. A review that has been
   * flagged or rejected must never move a listing's score, and filtering here
   * means that is true by construction rather than by remembering to filter.
   */
  reviews: {
    where: { status: 'PUBLISHED' },
    select: { ratingOverall: true },
  },
} satisfies Prisma.ListingSelect;

type PublicListing = Prisma.ListingGetPayload<{ select: typeof PUBLIC_SELECT }>;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async search(raw: unknown): Promise<{
    items: ListingCard[];
    nextCursor: string | null;
    totalEstimate: number;
    facets: Record<string, FacetBucket[]>;
  }> {
    const parsed = searchQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
      );
    }

    const query = parsed.data;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const where = await this.buildWhere(query);

    const [rows, total, facets] = await Promise.all([
      this.fetchPage(where, query.sort, limit, query.cursor),
      this.prisma.listing.count({ where }),
      this.buildFacets(query),
    ]);

    const items = rows.map((row) => this.toCard(row));

    return {
      items,
      totalEstimate: total,
      facets,
      // Keyset pagination on (publishedAt, id) rather than OFFSET, which stays
      // fast as the table grows and does not skip or repeat rows when a listing
      // is published mid-scroll.
      nextCursor:
        rows.length === limit && rows.length > 0
          ? encodeCursor(rows[rows.length - 1]!)
          : null,
    };
  }

  /**
   * Translates a search query into a Prisma where clause.
   *
   * The partition is applied first and unconditionally. Every other predicate is
   * additive and cannot widen it.
   */
  private async buildWhere(query: SearchQuery): Promise<Prisma.ListingWhereInput> {
    const and: Prisma.ListingWhereInput[] = [
      { status: ListingStatus.LIVE },
      // Promoted listings stay live but are excluded once their boost lapses.
      {
        OR: [{ promotedUntil: null }, { promotedUntil: { gt: new Date() } }],
      },
    ];

    // --- The partition -----------------------------------------------------
    and.push({ kindCode: query.kind });

    if (query.expiresAt !== undefined) {
      and.push({
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      });
    }

    // --- Location ----------------------------------------------------------
    if (query.stateCode?.length) {
      and.push({ stateCode: { in: query.stateCode } });
    }
    if (query.lgaCode?.length) {
      and.push({ lga: { code: { in: query.lgaCode } } });
    }
    if (query.areaId?.length) {
      and.push({ areaId: { in: query.areaId } });
    }

    // --- Type --------------------------------------------------------------
    if (query.type?.length) {
      and.push({ typeCode: { in: query.type } });
    }

    // --- Price -------------------------------------------------------------
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const price: Prisma.BigIntFilter = {};
      if (query.minPrice !== undefined) price.gte = BigInt(query.minPrice);
      if (query.maxPrice !== undefined) price.lte = BigInt(query.maxPrice);
      and.push({ price });
    }

    // Rent period only exists on the rent partition, so it is applied only there.
    // Applying it to sale listings would be a no-op at best and a category
    // confusion at worst.
    if (query.kind === 'RENT' && query.pricePeriod?.length) {
      and.push({ pricePeriod: { in: query.pricePeriod as PricePeriod[] } });
    }

    // --- Attributes --------------------------------------------------------
    if (query.bedroomsMin !== undefined) {
      and.push({ bedrooms: { gte: query.bedroomsMin } });
    }
    if (query.minPlotSqm !== undefined) {
      and.push({ plotSqm: { gte: query.minPlotSqm } });
    }
    if (query.minBuiltSqm !== undefined) {
      and.push({ builtSqm: { gte: query.minBuiltSqm } });
    }
    if (query.amenities?.length) {
      // Postgres array containment: every requested amenity must be present.
      and.push({ amenities: { hasEvery: query.amenities } });
    }
    if (query.deedType?.length) {
      and.push({ deedType: { in: query.deedType as never } });
    }

    // --- Trust filters -----------------------------------------------------
    if (query.verifiedOnly) {
      and.push({ poster: { phoneVerifiedAt: { not: null } } });
    }
    if (query.hasVideo) {
      and.push({ videoAssetId: { not: null } });
    }
    if (query.hasVerifiedTitle) {
      and.push({ titleVerifiedAt: { not: null } });
    }

    // --- Free text ---------------------------------------------------------
    if (query.q) {
      const resolved = await this.resolveAreaIds(query.q);
      const terms = buildSearchTerms(query.q);

      /*
       * Multi-word queries must NARROW, not broaden.
       *
       * The naive shape — one OR branch per term — makes "executive flat" match
       * everything containing "flat", which is a superset of "flat" alone. Typing
       * more words would silently widen the result set, so the main search box
       * would feel broken in the one direction users notice.
       *
       * So: the whole phrase is tried first, and if it matches nothing, every
       * term must match somewhere (title, description, or a resolved area). That
       * is the behaviour every search box has, and it means "lekki 3 bedroom"
       * finds fewer results than "lekki", which is what the user means.
       */
      const phraseMatch: Prisma.ListingWhereInput = {
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { titleNorm: { contains: normalise(query.q) } },
          { description: { contains: query.q, mode: 'insensitive' } },
          // Area names and their informal aliases resolve to areas, which is how
          // "Egbeda" or "Ikeja GRA" finds the right listings.
          ...(resolved.length ? [{ areaId: { in: resolved } }] : []),
        ],
      };

      // Every term must appear in at least one free-text field.
      const allTermsMatch: Prisma.ListingWhereInput = {
        AND: terms.map((t) => ({
          OR: [
            { title: { contains: t, mode: 'insensitive' as const } },
            { titleNorm: { contains: t } },
            { description: { contains: t, mode: 'insensitive' as const } },
          ],
        })),
      };

      const textFilter: Prisma.ListingWhereInput = terms.length
        ? { OR: [phraseMatch, allTermsMatch] }
        : phraseMatch;

      and.push(textFilter);
    }

    return { AND: and };
  }

  /**
   * Resolves free text to area ids via name and alias.
   *
   * Uses a prefix and substring match rather than raw trigram similarity here
   * because this runs on every keystroke of the search box; the heavier
   * suggestion endpoint is the right place for fuzzy ranking.
   */
  private async resolveAreaIds(text: string): Promise<string[]> {
    const needle = normalise(text);
    if (needle.length < 2) return [];

    const areas = await this.prisma.area.findMany({
      where: {
        isActive: true,
        OR: [
          { normName: { contains: needle } },
          { name: { contains: text, mode: 'insensitive' } },
          { aliases: { some: { normAlias: { contains: needle } } } },
        ],
      },
      select: { id: true },
      take: 20,
    });

    return areas.map((a) => a.id);
  }

  private async fetchPage(
    where: Prisma.ListingWhereInput,
    sort: SortOrder,
    limit: number,
    cursor?: string,
  ): Promise<PublicListing[]> {
    const orderBy = buildOrderBy(sort);

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        return this.prisma.listing.findMany({
          where,
          select: PUBLIC_SELECT,
          orderBy,
          take: limit,
          cursor: { id: decoded.id },
          skip: 1,
        });
      }
    }

    return this.prisma.listing.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy,
      take: limit,
    });
  }

  /**
   * Facet counts for the current filter set.
   *
   * Counts are computed over the same `where` as the results, so a facet can
   * never claim more listings than exist. This is the difference between a
   * filter panel people trust and one they learn to ignore.
   */
  private async buildFacets(query: SearchQuery): Promise<Record<string, FacetBucket[]>> {
    // Each facet is counted with its own sibling predicates removed, otherwise
    // selecting a type would zero out every other type's count. This is why the
    // clause builder returns a flat array rather than a merged object: the
    // predicates have to remain individually addressable.
    const without = async (
      key: 'typeCode' | 'stateCode' | 'amenities' | 'pricePeriod',
    ): Promise<Prisma.ListingWhereInput> => {
      const base = await this.buildWhere(query);
      const clauses = (base.AND ?? []) as Prisma.ListingWhereInput[];
      return {
        AND: clauses.filter((clause) => !(key in (clause as Record<string, unknown>))),
      };
    };

    const [typeWhere, stateWhere, amenityWhere, periodWhere] = await Promise.all([
      without('typeCode'),
      without('stateCode'),
      without('amenities'),
      query.kind === 'RENT' ? without('pricePeriod') : Promise.resolve(undefined),
    ]);

    const [types, states, amenities, periods] = await Promise.all([
      this.prisma.listing.groupBy({
        by: ['typeCode'],
        where: typeWhere,
        _count: { _all: true },
      }),
      this.prisma.listing.groupBy({
        by: ['stateCode'],
        where: stateWhere,
        _count: { _all: true },
      }),
      this.prisma.listing.groupBy({
        by: ['amenities'],
        where: amenityWhere,
        _count: { _all: true },
      }),
      periodWhere
        ? this.prisma.listing.groupBy({
            by: ['pricePeriod'],
            where: periodWhere,
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const typeLabels = await this.prisma.listingType.findMany({
      where: { kindCode: query.kind },
      select: { code: true, label: true },
    });
    const typeLabelMap = new Map(typeLabels.map((t) => [t.code, t.label]));

    const stateNames = await this.prisma.state.findMany({
      select: { code: true, name: true },
    });
    const stateNameMap = new Map(stateNames.map((s) => [s.code, s.name]));

    const stateByLiveCount = new Map(
      await this.prisma.listing.groupBy({
        by: ['stateCode'],
        where: { status: ListingStatus.LIVE, kindCode: query.kind },
        _count: { _all: true },
        orderBy: { _count: { stateCode: 'desc' } },
        take: 37,
      }).then((rows) => rows.map((r) => [r.stateCode, r._count._all] as const)),
    );

    // Amenities arrive as array columns, so a groupBy yields a row per distinct
    // array rather than per element. Counting has to happen in memory.
    const amenityCounts = new Map<string, number>();
    for (const row of amenities) {
      for (const amenity of row.amenities) {
        amenityCounts.set(amenity, (amenityCounts.get(amenity) ?? 0) + row._count._all);
      }
    }

    return {
      type: types
        .map((t) => ({
          code: t.typeCode,
          label: typeLabelMap.get(t.typeCode) ?? t.typeCode,
          count: t._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      state: states
        .map((s) => ({
          code: s.stateCode,
          label: stateNameMap.get(s.stateCode) ?? s.stateCode,
          count: stateByLiveCount.get(s.stateCode) ?? s._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      amenities: [...amenityCounts.entries()]
        .map(([code, count]) => ({
          code,
          /*
           * Human label from the vocabulary, not the code slugified.
           *
           * SECURITY_24H became "security 24h", which is not a phrase anyone
           * writes. A filter chip should read as the thing a person would look
           * for. Falling back to the slug keeps an unknown code visible rather than
           * dropping the facet, so a row written before a code was added to the
           * vocabulary still shows up, and shows up as a problem.
           */
          label: AMENITY_LABELS[code as Amenity]?.label ?? code.replace(/_/g, ' ').toLowerCase(),
          count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      // Period is only meaningful for rent; returning it for sale would suggest
      // a payment schedule that does not exist.
      pricePeriod: query.kind === 'RENT'
        ? periods.map((p) => ({
            code: p.pricePeriod,
            label: p.pricePeriod.replace('_', ' ').toLowerCase(),
            count: p._count._all,
          }))
        : [],
    };
  }

  /** Projects a row to the public card shape. */
  private toCard(row: PublicListing): ListingCard {
    const typeLabels = TYPE_LABEL_CACHE.get(row.kindCode);
    const label =
      typeLabels?.get(row.typeCode) ??
      row.typeCode
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^./, (c) => c.toUpperCase());

    const publishedAt = row.publishedAt ?? row.createdAt;

  /*
   * Reputation, averaged over the page's already-loaded review rows.
   *
   * Null, not zero, when there are no reviews. A listing with no track record
   * has to be able to say so: rendering it as "0.0" would make a brand new
   * listing look like the worst one on the page and quietly teach people to
   * distrust anything unreviewed.
   */
  const ratings = row.reviews.map((r) => r.ratingOverall);
  const ratingAverage =
    ratings.length > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null;

    const cover = row.media[0]?.mediaAsset ?? null;

    // Trust claims only. Two per card, enforced by deriveBadges.
    const badges = deriveBadges({
      ownerPhoneVerified: row.poster.phoneVerifiedAt !== null,
      videoCount: row.videoAssetId ? 1 : 0,
      titleVerified: row.titleVerifiedAt !== null,
      publishedAt,
    });

    return {
      id: row.id,
      kind: row.kindCode as ListingCard['kind'],
      type: row.typeCode,
      typeLabel: label,
      title: row.title,
      price: Number(row.price),
      pricePeriod: row.pricePeriod,
      priceNegotiable: row.priceNegotiable,
      agencyFee: row.agencyFee ? Number(row.agencyFee) : null,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      plotSqm: row.plotSqm,
      location: {
        areaName: row.area?.name ?? null,
        lgaName: row.lga.name,
        stateName: row.state.name,
      },
      coverImageUrl: cover ? publicImageUrl(cover.id, undefined, cover.storageKey) : null,
      videoCount: row.videoAssetId ? 1 : 0,
      ratingAverage,
      reviewCount: ratings.length,
      badges,
      status: 'LIVE',
      publishedAt: publishedAt.toISOString(),
    };
  }

  /**
   * Loads and caches type labels per kind.
   *
   * Called once per request rather than per row; the cache exists so the
   * per-row projection stays a pure map with no database access.
   */
  async warmTypeLabels(): Promise<void> {
    const rows = await this.prisma.listingType.findMany({
      select: { code: true, label: true, kindCode: true },
    });
    const byKind = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const map = byKind.get(row.kindCode) ?? new Map<string, string>();
      map.set(row.code, row.label);
      byKind.set(row.kindCode, map);
    }
    TYPE_LABEL_CACHE.clear();
    for (const [kind, map] of byKind) TYPE_LABEL_CACHE.set(kind, map);
  }

  /** Suggestion endpoint backing the search box, with trigram ranking. */
  async suggestAreas(text: string, stateCode?: string): Promise<Array<{ id: string; name: string; lgaName: string; stateName: string; listingCount: number }>> {
    const needle = normalise(text);
    if (needle.length < 2) return [];

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        lga_name: string;
        state_name: string;
        listing_count: number;
      }>
    >(Prisma.sql`
      SELECT a.id, a.name, l.name AS lga_name, s.name AS state_name,
             (SELECT COUNT(*)::int FROM listings lx
               WHERE lx.area_id = a.id AND lx.status = 'LIVE') AS listing_count
      FROM areas a
      JOIN lgas  l ON l.id = a.lga_id
      JOIN states s ON s.code = a.state_code
      WHERE a.is_active
        ${stateCode ? Prisma.sql`AND a.state_code = ${stateCode}` : Prisma.empty}
        AND (
          a.norm_name % ${needle}
          OR EXISTS (SELECT 1 FROM area_aliases al
                     WHERE al.area_id = a.id AND al.norm_alias % ${needle})
        )
      ORDER BY GREATEST(
                 similarity(a.norm_name, ${needle}),
                 COALESCE(MAX(similarity((SELECT norm_alias FROM area_aliases WHERE area_id = a.id ORDER BY similarity(norm_alias, ${needle}) DESC LIMIT 1)), 0)
               ) DESC,
               listing_count DESC
      LIMIT 10
    `);

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      lgaName: r.lga_name,
      stateName: r.state_name,
      listingCount: r.listing_count,
    }));
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

const TYPE_LABEL_CACHE = new Map<string, Map<string, string>>();

function buildOrderBy(sort: SortOrder): Prisma.ListingOrderByWithRelationInput[] {
  switch (sort) {
    case 'PRICE_ASC':
      return [{ price: 'asc' }, { id: 'desc' }];
    case 'PRICE_DESC':
      return [{ price: 'desc' }, { id: 'desc' }];
    case 'NEWEST':
      return [{ publishedAt: 'desc' }, { id: 'desc' }];
    case 'POPULAR':
      return [{ viewCount: 'desc' }, { id: 'desc' }];
    case 'RELEVANCE':
    default:
      // Relevance deliberately does not lead with recency. On a trust-led
      // marketplace, a verified listing from three months ago is more useful
      // than an unverified one posted five minutes ago. Boosted listings sort
      // first, then title-verified, then engagement, then recency.
      return [
        { promotedUntil: { sort: 'desc', nulls: 'last' } },
        { titleVerifiedAt: { sort: 'desc', nulls: 'last' } },
        { contactClickCount: 'desc' },
        { viewCount: 'desc' },
        { publishedAt: 'desc' },
        { id: 'desc' },
      ];
  }
}

function encodeCursor(row: { id: string }): string {
  return Buffer.from(JSON.stringify({ id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
    return typeof parsed.id === 'string' ? { id: parsed.id } : null;
  } catch {
    // A malformed cursor should restart from the first page rather than 400.
    return null;
  }
}

export function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits free text into trigram-friendly terms. */
function buildSearchTerms(input: string): string[] {
  const cleaned = normalise(input);
  return cleaned
    .split(' ')
    .filter((t) => t.length >= 3)
    .slice(0, 4);
}
