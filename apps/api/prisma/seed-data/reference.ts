import type { PrismaClient } from '@prisma/client';

/**
 * Nigeria's 36 states plus the Federal Capital Territory, with ISO 3166-2:NG
 * subdivision codes. Seeded at migration time so location pickers are complete
 * from day one, which is a stated requirement.
 *
 * LGA rows are seeded separately in `seed-lgas.ts` from the 774-LGA dataset.
 */

export const STATES: ReadonlyArray<{
  code: string;
  name: string;
  slug: string;
  centreLat: number | null;
  centreLng: number | null;
}> = [
  { code: 'AB', name: 'Abia', slug: 'abia', centreLat: 5.9527, centreLng: 7.4912 },
  { code: 'AD', name: 'Adamawa', slug: 'adamawa', centreLat: 9.4999, centreLng: 11.9696 },
  { code: 'AK', name: 'Akwa Ibom', slug: 'akwa-ibom', centreLat: 4.9757, centreLng: 7.8698 },
  { code: 'AN', name: 'Anambra', slug: 'anambra', centreLat: 6.1375, centreLng: 7.3208 },
  { code: 'BA', name: 'Bauchi', slug: 'bauchi', centreLat: 10.3157, centreLng: 9.8415 },
  { code: 'BY', name: 'Bayelsa', slug: 'bayelsa', centreLat: 4.6521, centreLng: 6.1469 },
  { code: 'BE', name: 'Benue', slug: 'benue', centreLat: 7.8739, centreLng: 8.6773 },
  { code: 'BO', name: 'Borno', slug: 'borno', centreLat: 11.8317, centreLng: 13.151 },
  { code: 'CR', name: 'Cross River', slug: 'cross-river', centreLat: 5.9506, centreLng: 8.3171 },
  { code: 'DE', name: 'Delta', slug: 'delta', centreLat: 5.8921, centreLng: 5.6983 },
  { code: 'EB', name: 'Ebonyi', slug: 'ebonyi', centreLat: 6.2648, centreLng: 8.1127 },
  { code: 'ED', name: 'Edo', slug: 'edo', centreLat: 6.6008, centreLng: 5.6037 },
  { code: 'EK', name: 'Ekiti', slug: 'ekiti', centreLat: 7.8979, centreLng: 4.7053 },
  { code: 'EN', name: 'Enugu', slug: 'enugu', centreLat: 6.4413, centreLng: 7.4988 },
  { code: 'GO', name: 'Gombe', slug: 'gombe', centreLat: 9.9283, centreLng: 11.3121 },
  { code: 'IM', name: 'Imo', slug: 'imo', centreLat: 5.5721, centreLng: 7.0345 },
  { code: 'JI', name: 'Jigawa', slug: 'jigawa', centreLat: 11.5561, centreLng: 9.6101 },
  { code: 'KD', name: 'Kaduna', slug: 'kaduna', centreLat: 10.5222, centreLng: 7.4384 },
  { code: 'KN', name: 'Kano', slug: 'kano', centreLat: 12.0022, centreLng: 8.592 },
  { code: 'KT', name: 'Katsina', slug: 'katsina', centreLat: 12.9908, centreLng: 7.6018 },
  { code: 'KE', name: 'Kebbi', slug: 'kebbi', centreLat: 12.4686, centreLng: 4.6268 },
  { code: 'KO', name: 'Kogi', slug: 'kogi', centreLat: 7.7887, centreLng: 6.0496 },
  { code: 'KW', name: 'Kwara', slug: 'kwara', centreLat: 8.5, centreLng: 4.5497 },
  { code: 'LA', name: 'Lagos', slug: 'lagos', centreLat: 6.4519, centreLng: 3.3958 },
  { code: 'NA', name: 'Nasarawa', slug: 'nasarawa', centreLat: 8.8996, centreLng: 7.8738 },
  { code: 'NI', name: 'Niger', slug: 'niger', centreLat: 9.0817, centreLng: 5.0573 },
  { code: 'OG', name: 'Ogun', slug: 'ogun', centreLat: 6.8594, centreLng: 3.4213 },
  { code: 'ON', name: 'Ondo', slug: 'ondo', centreLat: 7.0833, centreLng: 4.7333 },
  { code: 'OS', name: 'Osun', slug: 'osun', centreLat: 7.7827, centreLng: 4.5426 },
  { code: 'OY', name: 'Oyo', slug: 'oyo', centreLat: 7.3775, centreLng: 3.947 },
  { code: 'PL', name: 'Plateau', slug: 'plateau', centreLat: 9.0182, centreLng: 8.8978 },
  { code: 'RI', name: 'Rivers', slug: 'rivers', centreLat: 4.7631, centreLng: 7.0086 },
  { code: 'SO', name: 'Sokoto', slug: 'sokoto', centreLat: 13.0059, centreLng: 5.2476 },
  { code: 'TA', name: 'Taraba', slug: 'taraba', centreLat: 9.0639, centreLng: 11.4214 },
  { code: 'YO', name: 'Yobe', slug: 'yobe', centreLat: 12.0534, centreLng: 11.5254 },
  { code: 'ZA', name: 'Zamfara', slug: 'zamfara', centreLat: 12.1718, centreLng: 6.2534 },
  { code: 'FC', name: 'Federal Capital Territory', slug: 'fct', centreLat: 9.0765, centreLng: 7.3986 },
];

/**
 * SALE and RENT taxonomies, seeded as separate rows bound to their kind. The
 * `listing_type_kind_code` uniqueness constraint plus the `trg_listing_kind_coherence`
 * trigger mean a Rent type can never be attached to a Sale listing.
 */
export const KINDS = [
  { code: 'SALE', label: 'For Sale', pricePeriods: [], requiresDeedDoc: true },
  {
    code: 'RENT',
    label: 'For Rent',
    pricePeriods: ['MONTHLY', 'TWO_YEARLY', 'YEARLY'],
    requiresDeedDoc: false,
  },
] as const;

export const TYPES: ReadonlyArray<{
  code: string;
  label: string;
  kindCode: 'SALE' | 'RENT';
  requiresBedrooms?: boolean;
  requiresPlotSize?: boolean;
}> = [
  // --- SALE ---
  { code: 'DETACHED_HOUSE', label: 'Detached House', kindCode: 'SALE', requiresBedrooms: true, requiresPlotSize: true },
  { code: 'SEMI_DETACHED_HOUSE', label: 'Semi-Detached House', kindCode: 'SALE', requiresBedrooms: true, requiresPlotSize: true },
  { code: 'TERRACED_HOUSE', label: 'Terraced House', kindCode: 'SALE', requiresBedrooms: true, requiresPlotSize: true },
  { code: 'BUNGALOW', label: 'Bungalow', kindCode: 'SALE', requiresBedrooms: true, requiresPlotSize: true },
  { code: 'DUPLEX', label: 'Duplex', kindCode: 'SALE', requiresBedrooms: true, requiresPlotSize: true },
  { code: 'BLOCK_OF_FLATS', label: 'Block of Flats', kindCode: 'SALE', requiresBedrooms: true },
  { code: 'LAND', label: 'Land / Plot', kindCode: 'SALE', requiresPlotSize: true },
  { code: 'COMMERCIAL', label: 'Commercial Property', kindCode: 'SALE' },
  { code: 'OFFICE_SPACE', label: 'Office Space', kindCode: 'SALE' },
  { code: 'SHOP', label: 'Shop', kindCode: 'SALE' },
  { code: 'WAREHOUSE', label: 'Warehouse', kindCode: 'SALE' },
  { code: 'COWORKING_SPACE', label: 'Co-working Space', kindCode: 'SALE' },

  // --- RENT ---
  { code: 'ROOM_SINGLE', label: 'Single Room', kindCode: 'RENT' },
  { code: 'SELF_CONTAIN_1', label: 'Self-Contain (1-Room)', kindCode: 'RENT' },
  { code: 'ROOM_2', label: '2-Room', kindCode: 'RENT' },
  { code: 'ROOM_3', label: '3-Room', kindCode: 'RENT' },
  { code: 'BUNGALOW', label: 'Bungalow', kindCode: 'RENT', requiresBedrooms: true },
  { code: 'FLAT_APARTMENT', label: 'Flat / Apartment', kindCode: 'RENT', requiresBedrooms: true },
  { code: 'MINI_FLAT', label: 'Mini Flat', kindCode: 'RENT' },
  { code: 'SHARED_APARTMENT', label: 'Shared Apartment', kindCode: 'RENT' },
  { code: 'BUNK', label: 'Bunk', kindCode: 'RENT' },
  { code: 'SHORT_LET', label: 'Short-Let', kindCode: 'RENT', requiresBedrooms: true },
  { code: 'LAND_LEASE', label: 'Land Lease', kindCode: 'RENT', requiresPlotSize: true },
  { code: 'COMMERCIAL', label: 'Commercial Property', kindCode: 'RENT' },
  { code: 'OFFICE_SPACE', label: 'Office Space', kindCode: 'RENT' },
  { code: 'SHOP', label: 'Shop', kindCode: 'RENT' },
  { code: 'WAREHOUSE', label: 'Warehouse', kindCode: 'RENT' },
];

/**
 * Reference SLA policy. Target sits inside the stated 1-6 hour requirement:
 * target 180m (3h), warn at 240m (4h), escalate at 360m (6h).
 */
export const SLA_POLICIES = [
  { kindCode: 'SALE', targetMinutes: 180, warnMinutes: 240, escalateMinutes: 360 },
  { kindCode: 'RENT', targetMinutes: 180, warnMinutes: 240, escalateMinutes: 360 },
] as const;

/** Free-tier allowance. Paid entitlements arrive in Phase 5 via the NoopProvider. */
export const PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    tier: 0,
    priceNgn: BigInt(0),
    billingPeriod: 'MONTHLY',
    description: 'Post up to 3 listings per month. Contact reveal is unlimited.',
    entitlements: [
      { feature: 'LISTING_QUOTA', limit: { amount: 3, period: 'MONTH' } },
      { feature: 'CONTACT_REVEAL', limit: { amount: -1 } },
      { feature: 'SAVED_SEARCHES', limit: { amount: 5 } },
      { feature: 'CHAT', limit: { amount: -1 } },
      { feature: 'MEDIA_UPLOAD_GB', limit: { bytes: 2_147_483_648 } },
      { feature: 'FEATURED_LISTING', limit: { amount: 0 } },
      { feature: 'VERIFIED_TITLE_REVIEW', limit: { amount: 0 } },
    ],
  },
  {
    code: 'PRO',
    name: 'Naijaproperty Pro',
    tier: 1,
    priceNgn: BigInt(15000),
    billingPeriod: 'MONTHLY',
    description: 'For agents and agencies. 30 listings, featured placement, title review.',
    entitlements: [
      { feature: 'LISTING_QUOTA', limit: { amount: 30, period: 'MONTH' } },
      { feature: 'CONTACT_REVEAL', limit: { amount: -1 } },
      { feature: 'SAVED_SEARCHES', limit: { amount: 50 } },
      { feature: 'CHAT', limit: { amount: -1 } },
      { feature: 'MEDIA_UPLOAD_GB', limit: { bytes: 26_843_545_600 } },
      { feature: 'FEATURED_LISTING', limit: { amount: 10 } },
      { feature: 'VERIFIED_TITLE_REVIEW', limit: { amount: 30 } },
      { feature: 'LEADS_EXPORT', limit: { amount: -1 } },
    ],
  },
] as const;
