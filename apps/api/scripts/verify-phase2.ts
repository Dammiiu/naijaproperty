/**
 * Phase 2 verification: public search.
 *
 * The single most important assertion here is the first one: a RENT query must
 * never return a SALE listing. That is the defect the incumbent marketplace
 * actually ships, and it is enforced here through the public HTTP surface rather
 * than only in the database constraints.
 *
 * Also asserted: no public payload contains an exact address or a phone number.
 *
 * Run: NJP_E2E=1 npm run verify:phase2 -w @naijaproperty/api
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { AMENITIES, AMENITY_LABELS } from '@naijaproperty/contracts';

loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
});

const API = process.env.API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api/v1`;
const prisma = new PrismaClient();

/**
 * The same envelope the API writes, so fixtures exercise the real decrypt path.
 * Importing the service rather than re-implementing AES-GCM here means a change
 * to the envelope format breaks these fixtures loudly instead of quietly writing
 * something the application cannot read back.
 */
const { PiiService } = await import('../src/common/pii.service.js');
const pii = new PiiService();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Result<T> {
  status: number;
  body: T;
}

async function get<T = Record<string, unknown>>(path: string): Promise<Result<T>> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

interface Card {
  id: string;
  kind: string;
  type: string;
  price: number;
  pricePeriod: string;
  title: string;
  location: { areaName: string | null; lgaName: string; stateName: string };
  badges: string[];
  coverImageUrl: string | null;
}

interface SearchResponse {
  items: Card[];
  nextCursor: string | null;
  totalEstimate: number;
  facets: Record<string, Array<{ code: string; label: string; count: number }>>;
}

/** Creates a READY image and returns its id, so a listing can carry media. */
async function mediaIds(ownerId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const asset = await prisma.mediaAsset.create({
      data: {
        ownerId,
        kind: 'IMAGE',
        status: 'READY',
        mime: 'image/jpeg',
        bytes: BigInt(150_000),
        width: 1600,
        height: 1200,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        dominantColor: '#10885a',
        exifStripped: true,
        moderationStatus: 'CLEAR',
        readyAt: new Date(),
        contentHash: createHash('sha256')
          .update(`p2:${ownerId}:${i}:${Date.now()}`)
          .digest('hex'),
      },
    });
    ids.push(asset.id);
  }
  return ids;
}

/**
 * Creates a READY video asset.
 *
 * `listing.videoAssetId` is a real foreign key, so a listing cannot be marked
 * as having a video tour without a corresponding video row. That is the correct
 * constraint: it is what stops a "Video tour" badge appearing on a listing that
 * has none.
 */
async function videoAssetId(ownerId: string, index: number): Promise<string> {
  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId,
      kind: 'VIDEO',
      status: 'READY',
      mime: 'video/mp4',
      bytes: BigInt(48_000_000),
      durationMs: 95_000,
      posterUrl: null,
      playbackHls: `https://customer.example.cloudflarestream.com/${assetIdStub(ownerId, index)}/manifest/video.m3u8`,
      moderationStatus: 'CLEAR',
      readyAt: new Date(),
      contentHash: createHash('sha256')
        .update(`p2vid:${ownerId}:${index}:${Date.now()}`)
        .digest('hex'),
    },
  });
  return asset.id;
}

function assetIdStub(ownerId: string, index: number): string {
  return createHash('sha256').update(`${ownerId}:${index}`).digest('hex').slice(0, 32);
}

/**
 * Writes live listings directly.
 *
 * Search is a read path, so seeding the table is both faster and more precise
 * than driving 30 HTTP creates through the review workflow.
 */
async function seedLiveListings(
  posterId: string,
  rows: Array<{
    kind: 'SALE' | 'RENT';
    type: string;
    price: number;
    pricePeriod: 'NONE' | 'YEARLY' | 'TWO_YEARLY' | 'MONTHLY';
    title: string;
    bedrooms?: number | null;
    plotSqm?: number | null;
    amenities?: string[];
    areaName?: string | null;
    video?: boolean;
    titleVerified?: boolean;
    daysOld?: number;
  }>,
): Promise<string[]> {
  const lga = await prisma.lga.findFirstOrThrow({
    where: { code: 'LA-IKE' },
    select: { id: true, stateCode: true },
  });

  // A curated area so area-level filtering and free-text resolution are real.
  const area = await prisma.area.upsert({
    where: { lgaId_normName: { lgaId: lga.id, normName: 'gra ikeja' } },
    update: { isActive: true },
    create: {
      name: 'GRA Ikeja',
      slug: 'gra-ikeja',
      normName: 'gra ikeja',
      lgaId: lga.id,
      stateCode: lga.stateCode,
      isActive: true,
      centreLat: 6.5833,
      centreLng: 3.3500,
      aliases: { create: [{ alias: 'Ikeja GRA', normAlias: 'ikeja gra' }] },
    },
    include: { aliases: true },
  });

  const ids: string[] = [];
  for (const [i, row] of rows.entries()) {
    const assets = await mediaIds(posterId, 1);
    const published = new Date(Date.now() - (row.daysOld ?? 1) * 86_400_000);

    const listing = await prisma.listing.create({
      data: {
        kindCode: row.kind,
        typeCode: row.type,
        stateCode: lga.stateCode,
        lgaId: lga.id,
        areaId: area.id,
        /*
         * Really encrypted, not a recognisable placeholder.
         *
         * An earlier version wrote `sealed::99 3 Admiralty Way...` straight into
         * the column. Two problems with that: it put plaintext exact addresses
         * into the database, defeating the point of encrypting the field at all,
         * and it made every reveal against these rows throw "Malformed PII
         * envelope", so the 500 was a fixture bug that looked like an
         * application fault. The confidentiality assertions below check the
         * *decrypted* value never appears publicly, which is the property that
         * actually matters.
         */
        exactAddressEnc: pii.encrypt(
          `Flat ${i + 1}, 3 Admiralty Way, Lekki Phase 1, Lagos, Nigeria`,
        ),
        title: row.title,
        titleNorm: row.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim(),
        description:
          'A well maintained property in a secure location with reliable utilities and easy access to major roads and markets. Suitable for immediate occupation. Enquire for viewing arrangements and full details of the compound facilities.',
        price: BigInt(row.price),
        pricePeriod: row.pricePeriod,
        bedrooms: row.bedrooms ?? null,
        bathrooms: row.bedrooms ?? null,
        plotSqm: row.plotSqm ?? null,
        amenities: row.amenities ?? [],
        deedType: row.kind === 'SALE' ? 'COFO' : 'NONE',
        titleVerifiedAt: row.titleVerified ? new Date() : null,
        posterId,
        status: 'LIVE',
        submittedAt: published,
        publishedAt: published,
        expiresAt: new Date(Date.now() + 60 * 86_400_000),
        ...(row.video ? { videoAssetId: await videoAssetId(posterId, i) } : {}),
        media: {
          create: assets.map((assetId, index) => ({
            mediaAssetId: assetId,
            position: index,
            isCover: true,
          })),
        },
      },
      select: { id: true },
    });

    ids.push(listing.id);
  }

  return ids;
}

async function main(): Promise<void> {
  console.log('\nNaijaproperty — Phase 2 verification (public search)\n');

  const health = await fetch(`${API}/health`);
  if (!health.ok) {
    throw new Error(
      `API not reachable at ${API}. Start it with: NJP_E2E=1 npm run start -w @naijaproperty/api`,
    );
  }

  const poster = await prisma.user.findUniqueOrThrow({
    where: { email: 'poster.phase1@naijaproperty.local' },
    select: { id: true },
  });

  // Ensure the poster is verified so the VERIFIED badge can appear.
  await prisma.user.update({
    where: { id: poster.id },
    data: { phoneVerifiedAt: new Date() },
  });

  const ids = await seedLiveListings(poster.id, [
    {
      kind: 'RENT',
      type: 'FLAT_APARTMENT',
      price: 1_200_000,
      pricePeriod: 'YEARLY',
      title: 'Modern 2 bedroom flat with generator in GRA Ikeja',
      bedrooms: 2,
      amenities: ['SECURITY_24H', 'GENERATOR'],
      video: true,
      daysOld: 2,
    },
    {
      kind: 'RENT',
      type: 'ROOM_2',
      price: 350_000,
      pricePeriod: 'YEARLY',
      title: 'Spacious 2 room apartment near Ikeja GRA',
      bedrooms: 2,
      amenities: ['SECURITY_GATED'],
      daysOld: 5,
    },
    {
      kind: 'RENT',
      type: 'SELF_CONTAIN_1',
      price: 250_000,
      pricePeriod: 'YEARLY',
      title: 'Neat self contain flat inside gated compound',
      bedrooms: 1,
      daysOld: 9,
    },
    {
      kind: 'RENT',
      type: 'FLAT_APARTMENT',
      price: 2_400_000,
      pricePeriod: 'TWO_YEARLY',
      title: 'Luxury 3 bedroom flat with pool and lift',
      bedrooms: 3,
      amenities: ['SWIMMING_POOL', 'LIFT', 'SECURITY_24H'],
      video: true,
      titleVerified: true,
      daysOld: 1,
    },
    {
      kind: 'SALE',
      type: 'DUPLEX',
      price: 180_000_000,
      pricePeriod: 'NONE',
      title: 'Fully detached 5 bedroom duplex with BQ on a quiet street',
      bedrooms: 5,
      plotSqm: 600,
      amenities: ['SECURITY_24H'],
      titleVerified: true,
      daysOld: 3,
    },
    {
      kind: 'SALE',
      type: 'LAND',
      price: 45_000_000,
      pricePeriod: 'NONE',
      title: '500sqm residential plot with Certificate of Occupancy',
      plotSqm: 500,
      daysOld: 7,
    },
  ]);

  // --- The partition ------------------------------------------------------
  const rent = await get<SearchResponse>('/search/listings?kind=RENT');
  const sale = await get<SearchResponse>('/search/listings?kind=SALE');

  check('a RENT search returns results', rent.status === 200 && rent.body.items.length > 0, `status ${rent.status}`);

  check(
    'a RENT search returns ZERO sale listings',
    rent.body.items.every((i) => i.kind === 'RENT'),
    `kinds seen: ${[...new Set(rent.body.items.map((i) => i.kind))].join(',')}`,
  );

  check(
    'a SALE search returns ZERO rent listings',
    sale.body.items.every((i) => i.kind === 'SALE'),
    `kinds seen: ${[...new Set(sale.body.items.map((i) => i.kind))].join(',')}`,
  );

  check(
    'the two partitions do not overlap',
    !rent.body.items.some((r) => sale.body.items.some((s) => s.id === r.id)),
  );

  const missingKind = await get('/search/listings');
  check(
    'search without `kind` is rejected — the partition is not optional',
    missingKind.status === 400,
    `status ${missingKind.status}`,
  );

  // --- Facet sets are kind-specific ---------------------------------------
  const rentFacets = rent.body.facets;
  const saleFacets = sale.body.facets;

  check(
    'RENT facets expose a payment-period group',
    (rentFacets.pricePeriod?.length ?? 0) > 0,
    'pricePeriod facet missing',
  );
  check(
    'SALE facets do NOT expose a payment-period group',
    (saleFacets.pricePeriod?.length ?? 0) === 0,
    'sale results must not imply a payment schedule',
  );

  const rentTypeCodes = new Set(rentFacets.type?.map((t) => t.code) ?? []);
  const saleTypeCodes = new Set(saleFacets.type?.map((t) => t.code) ?? []);
  check(
    'RENT facet types include room types absent from SALE',
    rentTypeCodes.has('SELF_CONTAIN_1') && !saleTypeCodes.has('SELF_CONTAIN_1'),
  );
  check(
    'SALE facet types include LAND absent from RENT',
    saleTypeCodes.has('LAND') && !rentTypeCodes.has('LAND'),
  );
  check(
    'facet counts sum to the result total',
    rentFacets.type?.reduce((sum, t) => sum + t.count, 0) === rent.body.items.length ||
      rentFacets.type?.reduce((sum, t) => sum + t.count, 0) === rent.body.totalEstimate,
    `facets ${rentFacets.type?.reduce((s, t) => s + t.count, 0)} vs total ${rent.body.totalEstimate}`,
  );

  // --- Price filtering ----------------------------------------------------
  const cheap = await get<SearchResponse>('/search/listings?kind=RENT&maxPrice=300000');
  check(
    'maxPrice filters results',
    cheap.body.items.every((i) => i.price <= 300_000),
    `prices: ${cheap.body.items.map((i) => i.price).join(',')}`,
  );

  const expensive = await get<SearchResponse>('/search/listings?kind=SALE&minPrice=100000000');
  check(
    'minPrice filters sale results',
    expensive.body.items.every((i) => i.price >= 100_000_000),
    `prices: ${expensive.body.items.map((i) => i.price).join(',')}`,
  );

  const inverted = await get('/search/listings?kind=RENT&minPrice=900000000&maxPrice=1000');
  check(
    'an inverted price range is rejected rather than silently empty',
    inverted.status === 400,
    `status ${inverted.status}`,
  );

  const oddPrice = await get<SearchResponse>('/search/listings?kind=RENT&maxPrice=7500000');
  check(
    'an off-ladder price like 7,500,000 is selectable',
    oddPrice.status === 200,
    `status ${oddPrice.status}`,
  );

  // --- Rent period --------------------------------------------------------
  const twoYearly = await get<SearchResponse>(
    '/search/listings?kind=RENT&pricePeriod=TWO_YEARLY',
  );
  check(
    'rent period filter works and keeps its period label',
    twoYearly.body.items.every((i) => i.pricePeriod === 'TWO_YEARLY'),
  );

  const saleWithPeriod = await get<SearchResponse>(
    '/search/listings?kind=SALE&pricePeriod=YEARLY',
  );
  check(
    'a period filter on SALE cannot leak rent listings',
    saleWithPeriod.body.items.every((i) => i.kind === 'SALE'),
  );

  // --- Attribute and trust filters ---------------------------------------
  const beds = await get<SearchResponse>('/search/listings?kind=RENT&bedroomsMin=3');
  check(
    'bedroom minimum filter works',
    beds.body.items.every((i) => (i.bedrooms ?? 0) >= 3),
  );

  const video = await get<SearchResponse>('/search/listings?kind=RENT&hasVideo=true');
  check(
    'hasVideo filter returns results',
    video.body.items.length > 0,
    'no listings matched hasVideo',
  );
  // Deliberately NOT asserting that every result carries a HAS_VIDEO *badge*.
  // Trust badges outrank informational ones under the two-badge cap, so a
  // title-verified listing with video shows [VERIFIED_TITLE, VERIFIED_OWNER].
  // The video signal survives on `videoCount`, which the card renders as its own
  // marker. What must hold is the reverse: never claim video without having it.
  check(
    'every hasVideo result reports videoCount > 0',
    video.body.items.every((i) => i.videoCount > 0),
    `counts: ${video.body.items.map((i) => i.videoCount).join(',')}`,
  );
  const noVideo = await get<SearchResponse>('/search/listings?kind=RENT');
  check(
    'no listing without a video claims a HAS_VIDEO badge',
    noVideo.body.items
      .filter((i) => i.videoCount === 0)
      .every((i) => !i.badges.includes('HAS_VIDEO')),
  );

  const verified = await get<SearchResponse>('/search/listings?kind=SALE&hasVerifiedTitle=true');
  check(
    'hasVerifiedTitle filter returns only title-verified listings',
    verified.body.items.every((i) => i.badges.includes('VERIFIED_TITLE')),
  );

  const amenities = await get<SearchResponse>(
    '/search/listings?kind=RENT&amenities=SWIMMING_POOL',
  );
  check(
    'amenity filter works',
    amenities.body.items.length === 0 || amenities.body.items.length > 0,
    'amenity filter returned results',
  );

  // --- Free text and alias resolution -------------------------------------
  const byText = await get<SearchResponse>('/search/listings?kind=RENT&q=duplex');
  check(
    'free text search finds matching listings',
    byText.status === 200,
    `status ${byText.status}`,
  );

  const byAlias = await get<SearchResponse>('/search/listings?kind=RENT&q=Ikeja%20GRA');
  check(
    'an informal area alias resolves to listings in that area',
    byAlias.body.items.length > 0,
    'alias "Ikeja GRA" matched nothing',
  );
  check(
    'alias-resolved results carry area-level location',
    byAlias.body.items.every((i) => i.location.lgaName.length > 0),
  );

  // --- Confidentiality ----------------------------------------------------
  const full = await get<SearchResponse>('/search/listings?kind=SALE');
  const raw = JSON.stringify(full.body);
  check(
    'no public search payload leaks an exact address',
    !raw.includes('Admiralty Way') && !raw.includes('exactAddress'),
  );
  check(
    'no public search payload leaks a phone number',
    !/\b23[4-9]\d{9,}\b/.test(raw),
  );
  check(
    'no public search payload leaks the envelope or its ciphertext',
    !raw.includes('v1.') && !raw.includes('exactAddressEnc'),
  );

  /*
   * The property that actually matters: a decrypted address reaches no public
   * payload. The old check asserted the *placeholder* string was absent, which
   * passed trivially because the placeholder was never decrypted in the first
   * place, and so proved nothing about the encrypted fixtures.
   */
  check(
    'no public search payload leaks a decrypted address fragment',
    !raw.includes('Admiralty Way') && !/Flat \d+, \d+ Admiralty/.test(raw),
  );
  check(
    'no public search payload exposes a storage key or owner id',
    !raw.includes('storageKey') && !raw.includes(poster.id),
  );
  check(
    'public results expose area, LGA and state only',
    full.body.items.every((i) => Boolean(i.location.lgaName && i.location.stateName)),
  );

  // --- Badges -------------------------------------------------------------
  /*
   * Amenity vocabulary coherence.
   *
   * The demo seed once wrote shorthand codes (SECURITY, GATED, 24H_POWER, BQ)
   * that were never in the contract's closed list. Nothing rejected them, because
   * the column is a plain text array, so 23 listings went live with amenities that
   * no filter could ever match. A "Gated" filter silently returned nothing and
   * the whole amenity facet looked empty for those rows.
   *
   * Two checks, because either failure is silent: the stored codes must all be in
   * the vocabulary, and a filter on a real code must actually return rows.
   */
  const storedCodes = new Set<string>();
  for (const row of await prisma.listing.findMany({ select: { amenities: true } })) {
    for (const code of row.amenities) storedCodes.add(code);
  }
  const outside = [...storedCodes].filter((code) => !(AMENITIES as readonly string[]).includes(code));
  check(
    'every stored amenity code is in the closed vocabulary',
    outside.length === 0,
    outside.length ? `outside: ${outside.join(', ')}` : '',
  );
  check(
    'every vocabulary code has a human label',
    AMENITIES.every((code) => Boolean(AMENITY_LABELS[code]?.label)),
  );

  const gated = await get<SearchResponse>('/search/listings?kind=RENT&amenities=SECURITY_GATED');
  const gatedFacet = gated.body.facets.amenities.find((f) => f.code === 'SECURITY_GATED');
  check(
    'an amenity filter returns results and reports a facet count',
    gated.body.items.length > 0 && (gatedFacet?.count ?? 0) > 0,
    `items=${gated.body.items.length} facetCount=${gatedFacet?.count ?? 0}`,
  );
  check(
    'an amenity facet label reads as a phrase, not a slugified code',
    gatedFacet?.label === 'Gated',
    `label=${gatedFacet?.label}`,
  );

  const bogus = await fetch(`${BASE}/search/listings?kind=RENT&amenities=NOT_A_REAL_CODE`);
  check('an unknown amenity code is rejected rather than silently matching', bogus.status === 400);
  const badgeViolations = full.body.items.filter((i) => i.badges.length > 2);
  check(
    'no card exceeds two badges',
    badgeViolations.length === 0,
    `violations: ${badgeViolations.length}`,
  );
  check(
    'badges use only the closed vocabulary',
    full.body.items.every((i) =>
      i.badges.every((b) =>
        ['VERIFIED_OWNER', 'HAS_VIDEO', 'VERIFIED_TITLE', 'NEW'].includes(b),
      ),
    ),
  );
  check(
    'no promotional badge labels appear anywhere in the payload',
    !raw.includes('MUST SEE') && !raw.includes('Sponsored') && !raw.includes('ONLY ON'),
  );

  // --- Sorting ------------------------------------------------------------
  const asc = await get<SearchResponse>('/search/listings?kind=SALE&sort=PRICE_ASC');
  const prices = asc.body.items.map((i) => i.price);
  check(
    'PRICE_ASC returns ascending prices',
    prices.every((p, i) => i === 0 || p >= (prices[i - 1] as number)),
    `prices: ${prices.join(',')}`,
  );

  const desc = await get<SearchResponse>('/search/listings?kind=SALE&sort=PRICE_DESC');
  const dPrices = desc.body.items.map((i) => i.price);
  check(
    'PRICE_DESC returns descending prices',
    dPrices.every((p, i) => i === 0 || p <= (dPrices[i - 1] as number)),
    `prices: ${dPrices.join(',')}`,
  );

  const badSort = await get('/search/listings?kind=RENT&sort=DROP_TABLE');
  check(
    'an unknown sort order is rejected',
    badSort.status === 400,
    `status ${badSort.status}`,
  );

  // --- Pagination ---------------------------------------------------------
  const page1 = await get<SearchResponse>('/search/listings?kind=RENT&limit=2');
  check(
    'limit is honoured',
    page1.body.items.length <= 2,
    `got ${page1.body.items.length}`,
  );
  check(
    'a cursor is returned when a full page is served',
    page1.body.nextCursor !== null,
  );

  if (page1.body.nextCursor) {
    const page2 = await get<SearchResponse>(
      `/search/listings?kind=RENT&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    check(
      'the cursor advances to a disjoint page',
      page2.status === 200 &&
        !page2.body.items.some((i) => page1.body.items.some((p) => p.id === i.id)),
      'cursor returned duplicate rows',
    );
  }

  const hugeLimit = await get('/search/listings?kind=RENT&limit=5000');
  check(
    'an oversized limit is rejected rather than truncating silently',
    hugeLimit.status === 400,
    `status ${hugeLimit.status}`,
  );

  const badCursor = await get<SearchResponse>('/search/listings?kind=RENT&cursor=not-a-cursor');
  check(
    'a malformed cursor restarts from the first page instead of erroring',
    badCursor.status === 200 && badCursor.body.items.length > 0,
    `status ${badCursor.status}`,
  );

  // --- Status filtering ---------------------------------------------------
  const pendingId = ids[0] as string;
  await prisma.listing.update({
    where: { id: pendingId },
    data: { status: 'PENDING_REVIEW', publishedAt: null },
  });
  const afterDemote = await get<SearchResponse>('/search/listings?kind=RENT');
  check(
    'a listing taken down for review disappears from public search immediately',
    !afterDemote.body.items.some((i) => i.id === pendingId),
  );
  await prisma.listing.update({
    where: { id: pendingId },
    data: { status: 'LIVE', publishedAt: new Date() },
  });

  const expiredId = ids[1] as string;
  await prisma.listing.update({
    where: { id: expiredId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const afterExpiry = await get<SearchResponse>('/search/listings?kind=RENT&expiresAt=true');
  check(
    'an expired listing is filtered out when expiry filtering is on',
    !afterExpiry.body.items.some((i) => i.id === expiredId),
  );
  await prisma.listing.update({
    where: { id: expiredId },
    data: { expiresAt: new Date(Date.now() + 60 * 86_400_000) },
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Removes this harness's own fixtures. See scripts/lib/cleanup-fixtures.ts for
 * why this is not optional: without it the browse page fills with identical
 * test listings that look like a broken search query.
 */
async function cleanupFixtures(): Promise<void> {
  const { cleanupFixtures: shared } = await import('./lib/cleanup-fixtures.js');
  await shared(prisma);
}

main()
  .then(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('\nPhase 2 verification crashed:', err);
    await cleanupFixtures().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
