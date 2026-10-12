/**
 * Location suggestions with alias-aware fuzzy matching.
 *
 * The hard part of Nigerian location data is not the 36 states, it is the areas.
 * Listings use informal and overlapping names: "Egbeda", "Ikeja GRA",
 * "Adamu Baulkura", "Off Admiralty Way Lekki". Autocomplete therefore resolves
 * against `area_alias.norm_alias` with pg_trgm similarity, not just an exact
 * match on `area.name`.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { areaSuggestQuerySchema, type Area } from '@naijaproperty/contracts';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async suggest(raw: unknown): Promise<Area[]> {
    const parsed = areaSuggestQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const { q, stateCode, limit } = parsed.data;
    const needle = normalise(q);

    // Rank by the best trigram similarity across the area name and its aliases,
    // so an informal nickname surfaces the same result as the formal name.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string;
        lga_code: string;
        lga_name: string;
        state_code: string;
        state_name: string;
        centre_lat: number | null;
        centre_lng: number | null;
        matched_alias: string | null;
        similarity: number;
        listing_count: number;
      }>
    >`
      WITH candidates AS (
        SELECT
          a.id,
          a.name,
          a.slug,
          a.norm_name,
          l.code   AS lga_code,
          l.name   AS lga_name,
          s.code   AS state_code,
          s.name   AS state_name,
          a.centre_lat,
          a.centre_lng,
          al.alias AS matched_alias,
          GREATEST(
            similarity(a.norm_name, ${needle}),
            COALESCE(MAX(similarity(al.norm_alias, ${needle})), 0)
          ) AS similarity
        FROM areas a
        JOIN lgas  l ON l.id  = a.lga_id
        JOIN states s ON s.code = a.state_code
        LEFT JOIN area_aliases al ON al.area_id = a.id
        WHERE a.is_active
          ${stateCode ? Prisma.sql`AND a.state_code = ${stateCode}` : Prisma.empty}
        GROUP BY a.id, a.name, a.slug, a.norm_name, l.code, l.name, s.code, s.name,
                 a.centre_lat, a.centre_lng, al.alias
      )
      SELECT
        c.*,
        (SELECT COUNT(*)::int FROM listings lx
          WHERE lx.area_id = c.id AND lx.status = 'LIVE') AS listing_count
      FROM candidates c
      WHERE c.similarity > 0.3
      ORDER BY c.similarity DESC, listing_count DESC, c.name ASC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      lgaCode: r.lga_code,
      lgaName: r.lga_name,
      stateCode: r.state_code,
      stateName: r.state_name,
      centreLat: r.centre_lat,
      centreLng: r.centre_lng,
      listingCount: r.listing_count,
      ...(r.matched_alias && r.matched_alias.toLowerCase() !== r.name.toLowerCase()
        ? { matchedAlias: r.matched_alias }
        : {}),
    }));
  }

  /**
   * Records an area a poster referenced that does not exist yet.
   *
   * This is how area coverage grows from real supply rather than a data-entry
   * project: the listing is still submittable, the area sits inactive, and an
   * admin curates it later. `proposalCount` drives curation priority.
   */
  async propose(input: { name: string; lgaCode: string }): Promise<{ id: string; status: string }> {
    const name = input.name.trim();
    const normName = normalise(name);

    const lga = await this.prisma.lga.findUnique({ where: { code: input.lgaCode } });
    if (!lga) {
      throw ApiException.validation([
        { path: 'lgaCode', message: 'Select a valid local government area' },
      ]);
    }

    const existing = await this.prisma.area.findUnique({
      where: { lgaId_normName: { lgaId: lga.id, normName } },
    });

    if (existing) return { id: existing.id, status: existing.isActive ? 'active' : 'pending' };

    const area = await this.prisma.area.create({
      data: {
        name,
        slug: slugify(name),
        normName,
        lgaId: lga.id,
        stateCode: lga.stateCode,
        isActive: false,
        proposalCount: 1,
      },
    });

    return { id: area.id, status: 'pending' };
  }

  /**
   * Records an LGA a poster named that is not in the reference data.
   *
   * The alternative is refusing the listing, and refusing it is how a site ends
   * up empty in the places people actually live: Nigeria created far more LGAs
   * than any reference table here holds, and a landlord in one of them has no way
   * to list at all. So the name is stored, inactive, and an admin curates it later.
   *
   * Pending LGAs are returned by the `lgas` endpoint so the poster's own form can
   * keep showing what they typed instead of silently resetting the field.
   *
   * Requires auth, like area proposals: it writes rows that a human must later
   * confirm, and an anonymous caller has no business creating geography.
   */
  async proposeLga(input: {
    name: string;
    stateCode: string;
  }): Promise<{ id: string; code: string; status: string }> {
    const name = input.name.trim();

    const state = await this.prisma.state.findUnique({ where: { code: input.stateCode } });
    if (!state) {
      throw ApiException.validation([{ path: 'stateCode', message: 'Select a valid state' }]);
    }

    // Idempotent on (state, name): proposing the same LGA twice from two posters
    // must not create two rows that then need merging.
    const existing = await this.prisma.lga.findFirst({
      where: { stateCode: state.code, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      return { id: existing.id, code: existing.code, status: existing.isActive ? 'active' : 'pending' };
    }

    /*
     * A code derived from the name.
     *
     * The composite key is (stateCode, code), so a proposed LGA needs a code before
     * it can be referenced. Deriving it from the state plus a slug keeps it stable
     * and readable in the admin queue, where a cuid would be useless.
     *
     * `lgas.code` is VarChar(12), and the length is not a detail: an earlier
     * version sliced the slug to 12 and produced a 15-character code, which
     * Postgres rejected with "value too long for the column" and a bare 500. The
     * budget below is explicit, and a collision suffix is charged against it,
     * because a suffix that overflows is the same bug one collision later.
     */
    const CODE_MAX = 12;
    const prefix = `${state.code}-`;
    const suffixRoom = 2; // Room for "-2" through "-99" on a collision.
    const slug = (slugify(name).toUpperCase() || 'NEW').slice(
      0,
      CODE_MAX - prefix.length - suffixRoom,
    );
    const base = `${prefix}${slug}`;
    let code = base;
    for (let n = 2; await this.prisma.lga.findUnique({ where: { code }, select: { code: true } }); n++) {
      // Recompute from the budget rather than appending blindly, so the tenth
      // collision with a long name cannot produce an oversized code.
      code = `${prefix}${(slugify(name).toUpperCase() || 'NEW').slice(0, CODE_MAX - prefix.length - String(n).length - 1)}-${n}`;
    }

    const lga = await this.prisma.lga.create({
      data: {
        code,
        name,
        stateCode: state.code,
        // Not in the public index until an admin confirms it. isActive is what the
        // search filters and facets read, so a wrong name cannot leak into them.
        isActive: false,
        proposalCount: 1,
      },
    });

    return { id: lga.id, code: lga.code, status: 'pending' };
  }

  /** Admin curation: promote an inactive area into the public index. */
  async curate(areaId: string, opts: { centreLat?: number; centreLng?: number }) {
    return this.prisma.area.update({
      where: { id: areaId },
      data: { isActive: true, centreLat: opts.centreLat ?? null, centreLng: opts.centreLng ?? null },
    });
  }
}

/**
 * Normalisation used by both autocomplete and area creation, so "Ikeja GRA",
 * "ikeja gra" and "Ikeja-G.R.A" collapse to the same key.
 */
export function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(gra|css|estate|phase|ph)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(input: string): string {
  return normalise(input).replace(/\s+/g, '-').slice(0, 80);
}
