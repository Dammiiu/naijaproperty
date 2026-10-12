/**
 * Badge derivation with a hard cap.
 *
 * Mirrors the logic in @naijaproperty/ui so the API can compute badges for
 * server-rendered payloads and so the cap is enforceable in tests. Kept here as
 * the authoritative copy for server-side use.
 */

export const BADGE_CODES = [
  'VERIFIED_OWNER',
  'HAS_VIDEO',
  'VERIFIED_TITLE',
  'NEW',
] as const;

export type BadgeCode = (typeof BADGE_CODES)[number];

/** Two per card, no exceptions. This is the whole point. */
export const MAX_BADGES_PER_CARD = 2;

const NEW_LISTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function deriveBadges(input: {
  ownerPhoneVerified: boolean;
  videoCount: number;
  titleVerified: boolean;
  publishedAt: Date;
  now?: Date;
}): BadgeCode[] {
  const now = input.now ?? new Date();
  const isNew = now.getTime() - input.publishedAt.getTime() <= NEW_LISTING_WINDOW_MS;

  // Trust claims first: when the cap bites, credibility must survive.
  const trustFirst: BadgeCode[] = [];
  if (input.titleVerified) trustFirst.push('VERIFIED_TITLE');
  if (input.ownerPhoneVerified) trustFirst.push('VERIFIED_OWNER');

  const informational: BadgeCode[] = [];
  if (input.videoCount > 0) informational.push('HAS_VIDEO');
  if (isNew) informational.push('NEW');

  return [...trustFirst, ...informational].slice(0, MAX_BADGES_PER_CARD);
}
