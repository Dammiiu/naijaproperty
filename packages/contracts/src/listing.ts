/**
 * Listing kind. This is the root partition of the entire marketplace:
 * `kind` selects both the taxonomy and the facet set, and is not a filter.
 */

import { z } from 'zod';
import { nairaAmount } from './primitives.js';

export const listingKindSchema = z.enum(['SALE', 'RENT']);
export type ListingKind = z.infer<typeof listingKindSchema>;

export const pricePeriodSchema = z.enum([
  'NONE',
  'MONTHLY',
  'TWO_YEARLY',
  'YEARLY',
]);
export type PricePeriod = z.infer<typeof pricePeriodSchema>;

export const deedTypeSchema = z.enum([
  'NONE',
  'COFO',
  'EXCISION_GAZETTE',
  'SURVEY',
  'DEED_OF_ASSIGNMENT',
  'SUBJECT_TO',
]);
export type DeedType = z.infer<typeof deedTypeSchema>;

export const listingStatusSchema = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'LIVE',
  'REJECTED',
  'EXPIRED',
  'RESERVED',
  'SOLD',
  'ARCHIVED',
]);
export type ListingStatus = z.infer<typeof listingStatusSchema>;

/**
 * Disjoint taxonomies. A type code may only appear under one kind, mirroring
 * the `listing_type.kind_id` constraint in the database. This is the failure
 * mode PropertyPro has today, where Sale and Rent share one facet list.
 */
export const SALE_TYPES = [
  'DETACHED_HOUSE',
  'SEMI_DETACHED_HOUSE',
  'TERRACED_HOUSE',
  'BUNGALOW',
  'DUPLEX',
  'BLOCK_OF_FLATS',
  'LAND',
  'COMMERCIAL',
  'OFFICE_SPACE',
  'SHOP',
  'WAREHOUSE',
  'COWORKING_SPACE',
] as const;

export const RENT_TYPES = [
  'ROOM_SINGLE',
  'SELF_CONTAIN_1',
  'ROOM_2',
  'ROOM_3',
  'BUNGALOW',
  'FLAT_APARTMENT',
  'MINI_FLAT',
  'SHARED_APARTMENT',
  'BUNK',
  'SHORT_LET',
  'LAND_LEASE',
  'COMMERCIAL',
  'OFFICE_SPACE',
  'SHOP',
  'WAREHOUSE',
] as const;

export type SaleType = (typeof SALE_TYPES)[number];
export type RentType = (typeof RENT_TYPES)[number];

export const HUMAN_LABELS: Record<SaleType | RentType, string> = {
  DETACHED_HOUSE: 'Detached House',
  SEMI_DETACHED_HOUSE: 'Semi-Detached House',
  TERRACED_HOUSE: 'Terraced House',
  BUNGALOW: 'Bungalow',
  DUPLEX: 'Duplex',
  BLOCK_OF_FLATS: 'Block of Flats',
  LAND: 'Land / Plot',
  COMMERCIAL: 'Commercial Property',
  OFFICE_SPACE: 'Office Space',
  SHOP: 'Shop',
  WAREHOUSE: 'Warehouse',
  COWORKING_SPACE: 'Co-working Space',
  ROOM_SINGLE: 'Single Room',
  SELF_CONTAIN_1: 'Self-Contain (1-Room)',
  ROOM_2: '2-Room',
  ROOM_3: '3-Room',
  FLAT_APARTMENT: 'Flat / Apartment',
  MINI_FLAT: 'Mini Flat',
  SHARED_APARTMENT: 'Shared Apartment',
  BUNK: 'Bunk',
  SHORT_LET: 'Short-Let',
  LAND_LEASE: 'Land Lease',
};

/** Which type codes are legal for a given kind. */
export const TYPES_BY_KIND = {
  SALE: SALE_TYPES,
  RENT: RENT_TYPES,
} as const satisfies Record<ListingKind, readonly string[]>;

export const saleTypeSchema = z.enum(SALE_TYPES);
export const rentTypeSchema = z.enum(RENT_TYPES);

/**
 * Validates a type code against its kind. Used by every listing write path so
 * a Rent type can never be persisted against a Sale listing, even if a caller
 * bypasses the UI.
 */
export const typeForKindSchema = <K extends ListingKind>(kind: K) =>
  z.string().refine(
    (t) => (TYPES_BY_KIND[kind] as readonly string[]).includes(t),
    { message: `That property type is not available for ${kind === 'SALE' ? 'sale' : 'rent'}` },
  );

export const bedrooms = z.coerce.number().int().min(0).max(50).nullable();
export const bathrooms = z.coerce.number().int().min(0).max(50).nullable();
export const toilets = z.coerce.number().int().min(0).max(50).nullable();
export const parkingSpaces = z.coerce.number().int().min(0).max(500).nullable();

/**
 * Closed vocabulary of listing amenities.
 *
 * Closed on purpose. Amenities are what people filter on ("gated", "borehole",
 * "24h power"), and a filter over free text only matches what a poster happened
 * to type. So the codes are enumerated, the search facet is generated from this
 * list, and a poster who needs something absent proposes it for review rather
 * than inventing a code at post time.
 *
 * Kept in one list so the contract, the facet builder, the post form and the
 * search filter cannot drift apart. `WATER_SUPPLY` is deliberately distinct from
 * `BOREHOLE`: a compound can have constant water with no borehole of its own,
 * which is the normal case in Lagos.
 */
export const AMENITIES = [
  'SECURITY_24H',
  'SECURITY_GATED',
  'SECURITY_FLOODED',
  'GENERATOR',
  'SOLAR',
  'INVERTER',
  'BOREHOLE',
  'WATER_SUPPLY',
  'SWIMMING_POOL',
  'GYM',
  'LIFT',
  'PARKING',
  'FURNISHED',
  'SERVICED',
  'NEWLY_BUILT',
  'CLUBHOUSE',
  'PLAYGROUND',
  'COMMUNITY_HALL',
  'WASTAGE_DISPOSAL',
  'EV_CHARGING',
  'SMART_HOME',
  'GARDEN',
  'BALCONY',
  'BOYS_QUARTERS',
  'FENCED',
  'PAVED_ROAD',
  'CORNER_LOT',
] as const;

export const amenitySchema = z.enum(AMENITIES);
export type Amenity = z.infer<typeof amenitySchema>;

/**
 * Human label and short blurb for each code.
 *
 * Lives beside the vocabulary rather than in the UI package so the API can render
 * a facet label, a moderator can read a review queue entry, and the web app can
 * label a chip, all from one source. A code with no entry here is a bug, and
 * `verify:phase2` asserts every code has one.
 */
export const AMENITY_LABELS: Record<Amenity, { label: string; hint: string }> = {
  SECURITY_24H: { label: '24-hour power', hint: 'Power supply that does not cut off overnight' },
  SECURITY_GATED: { label: 'Gated', hint: 'Controlled access into the compound' },
  SECURITY_FLOODED: { label: 'Flooded', hint: 'The area has a known history of flooding' },
  GENERATOR: { label: 'Generator', hint: 'Standby power on the premises' },
  SOLAR: { label: 'Solar backup', hint: 'Solar power installed' },
  INVERTER: { label: 'Inverter', hint: 'Inverter and battery backup' },
  BOREHOLE: { label: 'Borehole', hint: 'Borehole water on the premises' },
  WATER_SUPPLY: { label: 'Constant water', hint: 'Water supplied to the tap, not fetched' },
  SWIMMING_POOL: { label: 'Swimming pool', hint: 'Pool on the premises' },
  GYM: { label: 'Gym', hint: 'Fitness facility available' },
  LIFT: { label: 'Lift', hint: 'Lift to the floor' },
  PARKING: { label: 'Parking', hint: 'Car parking, on premises or allocated' },
  FURNISHED: { label: 'Furnished', hint: 'Let with furniture' },
  SERVICED: { label: 'Serviced', hint: 'Estate pays for its own upkeep' },
  NEWLY_BUILT: { label: 'Newly built', hint: 'Recently completed' },
  CLUBHOUSE: { label: 'Clubhouse', hint: 'Shared recreation building' },
  PLAYGROUND: { label: 'Playground', hint: 'Play area for children' },
  COMMUNITY_HALL: { label: 'Community hall', hint: 'Shared hall for residents' },
  WASTAGE_DISPOSAL: { label: 'Waste disposal', hint: 'Waste collected on the premises' },
  EV_CHARGING: { label: 'EV charging', hint: 'Charging point installed' },
  SMART_HOME: { label: 'Smart home', hint: 'Automated or app-controlled systems' },
  GARDEN: { label: 'Garden', hint: 'Garden or green space on the premises' },
  BALCONY: { label: 'Balcony', hint: 'Balcony or decking' },
  BOYS_QUARTERS: { label: "Boys' quarters", hint: "Separate servant's quarters, a BQ" },
  FENCED: { label: 'Fenced', hint: 'Perimeter wall or fencing' },
  PAVED_ROAD: { label: 'Paved road', hint: 'Access road is tarred' },
  CORNER_LOT: { label: 'Corner plot', hint: 'Two roads meet at the plot' },
};

/**
 * Base listing fields. `createListingSchema` refines this per kind so that
 * sale listings require deed-relevant data and rent listings require payment
 * period data - enforced in the contract layer and mirrored in the database.
 */
export const listingCoreSchema = z.object({
  kind: listingKindSchema,
  type: z.string().min(1),
  stateCode: z.string().length(2).toUpperCase(),
  lgaCode: z.string().min(1).max(12),
  areaId: z.string().cuid().optional(),
  /** Reveal-gated. Never serialised in public payloads. */
  exactAddress: z.string().trim().min(5).max(400),
  title: z.string().trim().min(10, 'Give your listing a clearer title').max(160),
  description: z
    .string()
    .trim()
    .min(60, 'Describe the property in at least 60 characters')
    .max(8000),
  price: nairaAmount,
  priceNegotiable: z.boolean().default(false),
  bedrooms: bedrooms.default(null),
  bathrooms: bathrooms.default(null),
  toilets: toilets.default(null),
  parkingSpaces: parkingSpaces.default(null),
  plotSqm: z.coerce.number().int().positive().max(1_000_000).nullable().default(null),
  builtSqm: z.coerce.number().int().positive().max(1_000_000).nullable().default(null),
  amenities: z.array(amenitySchema).max(AMENITIES.length).default([]),
  deedType: deedTypeSchema.default('NONE'),
});

export const createListingSchema = listingCoreSchema
  .superRefine((val, ctx) => {
    const kindCheck = typeForKindSchema(val.kind).safeParse(val.type);
    if (!kindCheck.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: kindCheck.error.issues[0]?.message ?? 'Invalid property type',
      });
    }

    if (val.kind === 'SALE') {
      if (val.price > 0 && val.price < 100_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['price'],
          message: 'Sale prices below N100,000 look incorrect',
        });
      }
      // Title verification is the core trust mechanism, so a deed type is
      // required for anything sold as land or a whole property.
      if (val.type === 'LAND' && val.deedType === 'NONE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deedType'],
          message: 'Land listings must declare a title type',
        });
      }
    }

    if (val.kind === 'RENT' && val.price <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'Rent listings need a rent amount',
      });
    }
  })
  .and(
    z.object({
      /** MONTHLY | TWO_YEARLY | YEARLY. Required for rent, forbidden for sale. */
      pricePeriod: pricePeriodSchema.optional(),
      /** Number of months or years the advance covers. */
      paymentAdvance: z.coerce.number().int().min(1).max(120).nullable().default(null),
      agencyFee: z.coerce.number().int().min(0).nullable().default(null),
      minimumStayMonths: z.coerce.number().int().min(1).max(120).nullable().default(null),
      mediaAssetIds: z.array(z.string().cuid()).min(5, 'Upload at least 5 photos').max(40),
      videoAssetId: z.string().cuid().optional(),
      deedDocumentAssetId: z.string().cuid().optional(),
    }),
  )
  .superRefine((val, ctx) => {
    if (val.kind === 'RENT') {
      if (!val.pricePeriod || val.pricePeriod === 'NONE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pricePeriod'],
          message: 'Choose how often rent is paid',
        });
      }
    } else if (val.pricePeriod && val.pricePeriod !== 'NONE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricePeriod'],
        message: 'Sale listings have no payment period',
      });
    }

    /*
     * Title: required to sell, optional to rent.
     *
     * Someone buying land or a house is handing over life savings against a piece
     * of paper, and an unevidenced claim is the most common way people are
     * defrauded in Nigeria. So a sale must say what title exists. `SUBJECT_TO` is
     * the honest answer when verification is still in progress, which means a
     * seller is never pushed into claiming a title they do not hold; blocking
     * them instead would just move the listing off-platform.
     *
     * A renter has no stake in the title. Demanding a deed to let a flat would
     * lock out exactly the ordinary landlords this platform is for, so `NONE` is
     * a legitimate answer for rent and only for rent.
     */
    if (val.kind === 'SALE' && (!val.deedType || val.deedType === 'NONE')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deedType'],
        message: 'Tell us what title you hold, or choose "Sale is subject to documentation"',
      });
    }
  });

export type CreateListingInput = z.input<typeof createListingSchema>;
export type CreateListingPayload = z.output<typeof createListingSchema>;
