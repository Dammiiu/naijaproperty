/**
 * Search, media, and contact-reveal contracts.
 */

import { z } from 'zod';
import { cuid, nairaAmount } from './primitives.js';
import {
  AMENITIES,
  deedTypeSchema,
  listingKindSchema,
  listingStatusSchema,
  pricePeriodSchema,
} from './listing.js';

export const sortOrderSchema = z.enum([
  'RELEVANCE',
  'NEWEST',
  'PRICE_ASC',
  'PRICE_DESC',
  'POPULAR',
]);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/**
 * Search input. `kind` is mandatory and selects the facet set - it is a
 * partition, not an optional filter.
 */
/**
 * Accepts either a repeated query parameter (`?type=A&type=B`, which arrives as
 * an array) or a single one (`?type=A`, which arrives as a string).
 *
 * Without this every multi-select filter breaks for a normal client that sends
 * one value, which is the common case. Empty strings are dropped so a bare
 * `?type=` behaves like an absent filter rather than matching the empty string.
 */
function queryList<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) {
      const kept = value.filter((v) => v !== '' && v !== undefined && v !== null);
      return kept.length ? kept : undefined;
    }
    return [value];
  }, z.array(inner).optional());
}

export const searchQuerySchema = z
  .object({
    kind: listingKindSchema,
    /** Space/area/LGA alias text. Resolved against area_alias with fuzzy match. */
    q: z.string().trim().max(120).optional(),
    type: queryList(z.string().max(32)),
    stateCode: queryList(z.string().length(2).toUpperCase()),
    lgaCode: queryList(z.string().max(12)),
    areaId: queryList(z.string().cuid()),
    minPrice: nairaAmount.optional(),
    maxPrice: nairaAmount.optional(),
    pricePeriod: queryList(pricePeriodSchema),
    bedroomsMin: z.coerce.number().int().min(0).max(50).optional(),
    amenities: queryList(z.enum(AMENITIES)),
    deedType: queryList(deedTypeSchema),
    minPlotSqm: z.coerce.number().int().positive().optional(),
    minBuiltSqm: z.coerce.number().int().positive().optional(),
    verifiedOnly: z.coerce.boolean().optional(),
    hasVideo: z.coerce.boolean().optional(),
    hasVerifiedTitle: z.coerce.boolean().optional(),
    sort: sortOrderSchema.default('RELEVANCE'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    /** Internal: filters out expired-but-still-live listings. */
    expiresAt: z.coerce.boolean().optional(),
  })
  .refine(
    (v) =>
      v.minPrice === undefined ||
      v.maxPrice === undefined ||
      v.minPrice <= v.maxPrice,
    { path: ['maxPrice'], message: 'Maximum price must be above the minimum' },
  );

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const facetBucketSchema = z.object({
  code: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
});
export type FacetBucket = z.infer<typeof facetBucketSchema>;

export const facetSetSchema = z.object({
  /** The facet groups valid for the requested kind, with live counts. */
  groups: z.record(z.string(), z.array(facetBucketSchema)),
});

export const listingCardSchema = z.object({
  id: cuid,
  kind: listingKindSchema,
  type: z.string(),
  typeLabel: z.string(),
  title: z.string(),
  price: nairaAmount,
  pricePeriod: pricePeriodSchema,
  priceNegotiable: z.boolean(),
    /*
     * Agent or owner fee in naira, null when the poster charges none.
     *
     * Public on purpose. The whole positioning is that no fee is hidden, and that
     * claim is only credible if the number is on the card before you make contact,
     * not buried on the detail page. The schema keeps it nullable rather than
     * defaulting to zero, because "no fee stated" and "stated as zero" are
     * different claims and collapsing them would overstate what we know.
     */
    agencyFee: z.number().int().nonnegative().nullable(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  plotSqm: z.number().int().nullable(),
  /** Area + LGA + state only. Exact address requires contact reveal. */
  location: z.object({
    areaName: z.string().nullable(),
    lgaName: z.string(),
    stateName: z.string(),
  }),
  coverImageUrl: z.string().nullable(),
  videoCount: z.number().int().nonnegative(),
  /**
   * Mean of published reviews, or null when there are none.
   *
   * Null rather than 0 on purpose. A listing nobody has reviewed yet has no
   * reputation, which is not the same as a bad one, and rendering it as 0 makes
   * every new listing look like the worst thing on the page.
   */
  ratingAverage: z.number().min(1).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  badges: z.array(z.enum(['VERIFIED_OWNER', 'HAS_VIDEO', 'VERIFIED_TITLE', 'NEW'])),
  status: listingStatusSchema,
  publishedAt: z.string(),
});

export type ListingCard = z.infer<typeof listingCardSchema>;

export const searchResponseSchema = z.object({
  items: z.array(listingCardSchema),
  facets: facetSetSchema,
  nextCursor: z.string().nullable(),
  totalEstimate: z.number().int().nonnegative(),
});

export const areaSuggestionSchema = z.object({
  id: cuid,
  name: z.string(),
  lgaName: z.string(),
  stateName: z.string(),
  /** The alias text that matched, when the match came from area_alias. */
  matchedAlias: z.string().optional(),
});

export const areaSuggestQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
  stateCode: z.string().length(2).toUpperCase().optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// --- Media -----------------------------------------------------------------

export const mediaKindSchema = z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']);
export const mediaStatusSchema = z.enum([
  'PENDING',
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'QUARANTINED',
]);

export const presignImageRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
  bytes: z.coerce
    .number()
    .int()
    .positive()
    .max(15 * 1024 * 1024, 'Each photo must be under 15MB'),
});

export const presignVideoRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']),
  bytes: z.coerce
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024, 'Video must be under 2GB'),
});

export const presignResponseSchema = z.object({
  assetId: cuid,
  status: mediaStatusSchema,
  /**
   * For images this is an R2 presigned PUT.
   * For video this is a Stream Direct Creator Upload URL (tus, resumable).
   */
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresInSeconds: z.number().int(),
  /** Max bytes the presigned URL accepts, so the client can fail fast. */
  maxBytes: z.number().int(),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;

export const completeUploadSchema = z.object({
  assetId: cuid,
  /** Client-computed sha256, used for per-owner dedupe. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

export const mediaAssetSchema = z.object({
  id: cuid,
  kind: mediaKindSchema,
  status: mediaStatusSchema,
  bytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blurhash: z.string().nullable(),
  dominantColor: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  playbackHls: z.string().nullable(),
  moderationStatus: z.enum(['PENDING', 'CLEAR', 'FLAGGED', 'REJECTED']),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

// --- Contact reveal --------------------------------------------------------

export const revealRequestSchema = z.object({
  listingId: cuid,
});
export type RevealRequest = z.infer<typeof revealRequestSchema>;

/**
 * Returned only to an authenticated user. This is the sole response in the
 * codebase that contains a decrypted phone number or exact address, and every
 * issuance writes a contact_reveal audit row first.
 */
export const revealResponseSchema = z.object({
  listingId: cuid,
  owner: z.object({
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    verificationTier: z.string(),
    memberSince: z.string(),
    responseRate: z.number().min(0).max(100),
  }),
  phone: z.string(),
  whatsappUrl: z.string(),
  exactAddress: z.string(),
  conversationId: cuid,
  alreadyRevealed: z.boolean(),
});
export type RevealResponse = z.infer<typeof revealResponseSchema>;

export const areaLockedMessage =
  'Exact address and owner contact are available after sign-in.';
