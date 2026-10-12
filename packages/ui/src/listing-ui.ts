/**
 * Badge vocabulary. Deliberately closed and capped at two per card.
 *
 * This is a direct response to the observed state of the market: PropertyPro
 * stacks MUST SEE / Sponsored / Premium Gold / RECOMMENDED / ONLY ON
 * PROPERTYPRO / SERVICED ONLY ON PROPERTYPRO / NEWLY BUILT ONLY ON PROPERTYPRO
 * onto single cards, which trains users to ignore every badge. We hold the
 * line at two, and every badge here is a verifiable claim.
 */

import type { Amenity, ListingKind } from '@naijaproperty/contracts';
import { AMENITY_LABELS as CONTRACT_AMENITY_LABELS } from '@naijaproperty/contracts';

export const BADGE_CODES = [
  'VERIFIED_OWNER',
  'HAS_VIDEO',
  'VERIFIED_TITLE',
  'NEW',
] as const;

export type BadgeCode = (typeof BADGE_CODES)[number];

export const MAX_BADGES_PER_CARD = 2;

interface BadgeDefinition {
  code: BadgeCode;
  label: string;
  /** Explains what was actually verified, for the tooltip and a11y label. */
  title: string;
  tone: 'verified' | 'title' | 'video' | 'new';
}

export const BADGES: Record<BadgeCode, BadgeDefinition> = {
  VERIFIED_OWNER: {
    code: 'VERIFIED_OWNER',
    label: 'Verified',
    title: 'Phone number confirmed by SMS or WhatsApp OTP',
    tone: 'verified',
  },
  HAS_VIDEO: {
    code: 'HAS_VIDEO',
    label: 'Video tour',
    title: 'Walkthrough video uploaded by the poster',
    tone: 'video',
  },
  VERIFIED_TITLE: {
    code: 'VERIFIED_TITLE',
    label: 'Title checked',
    title: 'Title documents reviewed by our team',
    tone: 'title',
  },
  NEW: {
    code: 'NEW',
    label: 'New',
    title: 'Listed in the last 7 days',
    tone: 'new',
  },
};

/**
 * Derives the badge set from verified facts, then caps the total. Trust badges
 * win over informational ones when the cap bites, because the whole value
 * proposition of the product is credibility.
 */
export function deriveBadges(input: {
  ownerPhoneVerified: boolean;
  videoCount: number;
  titleVerified: boolean;
  publishedAt: Date;
  now?: Date;
}): BadgeCode[] {
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - input.publishedAt.getTime();
  const isNew = ageMs <= 7 * 24 * 60 * 60 * 1000;

  const trustFirst: BadgeCode[] = [];
  if (input.titleVerified) trustFirst.push('VERIFIED_TITLE');
  if (input.ownerPhoneVerified) trustFirst.push('VERIFIED_OWNER');

  const informational: BadgeCode[] = [];
  if (input.videoCount > 0) informational.push('HAS_VIDEO');
  if (isNew) informational.push('NEW');

  return [...trustFirst, ...informational].slice(0, MAX_BADGES_PER_CARD);
}

export function badgeToneClass(code: BadgeCode): string {
  switch (BADGES[code].tone) {
    case 'verified':
      return 'njp-badge--verified';
    case 'title':
      return 'njp-badge--title';
    case 'video':
      return 'njp-badge--video';
    case 'new':
      return 'njp-badge--new';
  }
}

// --- Currency formatting ---------------------------------------------------

const NAIRA_PREFIX = '\u20a6';

/**
 * Compact naira for dense card layouts. PropertyPro renders
 * "N159,000,000/year" at full width, which dominates the card. We shorten to
 * "N159M" and keep the exact figure in the accessible label and detail page.
 */
export function formatNaira(amount: number, opts?: { compact?: boolean }): string {
  const compact = opts?.compact ?? false;

  if (!compact) return `${NAIRA_PREFIX}${amount.toLocaleString('en-NG')}`;

  if (amount >= 1_000_000_000) {
    const v = amount / 1_000_000_000;
    return `${NAIRA_PREFIX}${trimNumber(v)}B`;
  }
  if (amount >= 1_000_000) {
    const v = amount / 1_000_000;
    return `${NAIRA_PREFIX}${trimNumber(v)}M`;
  }
  if (amount >= 1_000) {
    const v = amount / 1_000;
    return `${NAIRA_PREFIX}${trimNumber(v)}K`;
  }
  return `${NAIRA_PREFIX}${amount}`;
}

function trimNumber(v: number): string {
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return String(rounded);
}

/**
 * Rent period suffix. PropertyPro normalises everything to "/year", which
 * discards the pay-2-years-upfront convention that drives Nigerian rentals.
 * We show the period as stated by the poster.
 */
export function formatPricePeriod(
  period: 'NONE' | 'MONTHLY' | 'TWO_YEARLY' | 'YEARLY',
): string {
  switch (period) {
    case 'MONTHLY':
      return '/month';
    case 'TWO_YEARLY':
      return '/2 years';
    case 'YEARLY':
      return '/year';
    case 'NONE':
      return '';
  }
}

/**
 * Log-scaled price step suggestions for the range inputs. PropertyPro's ladder
 * is 50k/100k/200k then jumps to 1m/2m/3m/5m, so a N7.5M budget is not
 * selectable at all. We generate steps that stay usable across the whole
 * N50k - N2bn span.
 */
export function priceStepSuggestions(limit = 12): number[] {
  const anchors = [
    50_000, 100_000, 200_000, 400_000, 800_000, 1_200_000, 2_000_000,
    3_500_000, 5_000_000, 7_500_000, 10_000_000, 15_000_000, 20_000_000,
    30_000_000, 50_000_000, 75_000_000, 100_000_000, 150_000_000, 200_000_000,
    350_000_000, 500_000_000, 750_000_000, 1_000_000_000, 2_000_000_000,
  ];
  if (anchors.length <= limit) return anchors;

  const step = anchors.length / limit;
  const out: number[] = [];
  for (let i = 0; i < limit; i += 1) out.push(anchors[Math.floor(i * step)]!);
  return out;
}

/**
 * Human label for an amenity code.
 *
 * Reads the contract's vocabulary rather than keeping a second copy. There were
 * two label maps: this one and the one in `@naijaproperty/contracts`. They had
 * already drifted, which is how a code ends up filterable but unlabelled, or
 * labelled one way in a facet and another way on a card.
 */
export function amenityLabel(a: Amenity): string {
  return CONTRACT_AMENITY_LABELS[a]?.label ?? a.replace(/_/g, ' ').toLowerCase();
}

/** The blurb behind an amenity, for a tooltip or a hint under a chip. */
export function amenityHint(a: Amenity): string {
  return CONTRACT_AMENITY_LABELS[a]?.hint ?? '';
}

export function kindLabel(kind: ListingKind): string {
  return kind === 'SALE' ? 'For Sale' : 'For Rent';
}
