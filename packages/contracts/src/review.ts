/**
 * Review contracts.
 *
 * A review is left by a tenant/buyer about a listing they have interacted with.
 * Eligibility is enforced by the API: the reviewer must have either revealed the
 * contact (contactReveal) or have a confirmed StayRecord.
 *
 * The review has an overall rating (1-5) and optional sub-ratings.
 * Status can be PUBLISHED, PENDING (moderation), REJECTED, or FLAGGED.
 * Votes allow other users to upvote/downvote helpfulness.
 */

import { z } from 'zod';
import { cuid } from './primitives.js';

export const reviewEligibilitySchema = z.enum(['REVEALED', 'STAY_RECORDED', 'ADMIN_OVERRIDE']);
export type ReviewEligibility = z.infer<typeof reviewEligibilitySchema>;

export const reviewStatusSchema = z.enum(['PUBLISHED', 'PENDING', 'REJECTED', 'FLAGGED']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const ratingSchema = z.number().int().min(1).max(5);
export const optionalRatingSchema = ratingSchema.optional();

export const reviewVoteValueSchema = z.number().int().min(-1).max(1);
export type ReviewVoteValue = z.infer<typeof reviewVoteValueSchema>;

/*
 * `listingId` is deliberately absent.
 *
 * The review is posted to `POST /listings/:id/reviews`, so the id is already in
 * the path. Requiring it in the body as well meant a caller that followed the
 * route shape exactly was rejected with "listingId: Required" and could never
 * succeed. The API takes the listing from the path and ignores any id in the
 * body, so a mismatched pair cannot review the wrong listing.
 */
export const createReviewRequestSchema = z.object({
  ratingOverall: ratingSchema,
  ratingCommunication: optionalRatingSchema,
  ratingAccuracy: optionalRatingSchema,
  ratingValue: optionalRatingSchema,
  body: z.string().trim().min(50).max(4000),
  eligibility: reviewEligibilitySchema,
});

export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;

export const reviewResponseSchema = z.object({
  id: cuid,
  listingId: cuid,
  authorId: cuid,
  authorDisplayName: z.string(),
  authorVerificationTier: z.enum(['UNVERIFIED', 'PHONE_VERIFIED', 'DOCUMENT_VERIFIED']),
  ratingOverall: ratingSchema,
  ratingCommunication: optionalRatingSchema,
  ratingAccuracy: optionalRatingSchema,
  ratingValue: optionalRatingSchema,
  body: z.string(),
  eligibility: reviewEligibilitySchema,
  status: reviewStatusSchema,
  helpfulCount: z.number().int().nonnegative(),
  notHelpfulCount: z.number().int().nonnegative(),
  userVote: reviewVoteValueSchema.nullable(),
  createdAt: z.string(),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/**
 * Aggregate rating for a listing.
 *
 * The user's stated purpose for reviews is that they should carry credibility
 * forward: a poster with a history of bad rentals should be visibly harder to
 * patronise. That only works if the score travels with the listing rather than
 * living inside the reviews panel. A reader who never scrolls to the reviews
 * section must still see that a listing has a poor record.
 *
 * `average` is null rather than 0 when there are no published reviews. Zero is a
 * real rating and the worst possible one, so defaulting to it would make an
 * unreviewed listing look like the most hated listing on the site. The UI must
 * branch on null and say nothing at all rather than showing an empty score.
 *
 * `distribution` is keyed by rating, 1 through 5, so the UI can render a
 * histogram without reshaping the data. Every key is always present, so the
 * bars do not jump around as counts change.
 */
export const reviewSummarySchema = z.object({
  average: z.number().min(1).max(5).nullable(),
  /** Number of published reviews backing the average. */
  count: z.number().int().nonnegative(),
  /** Rating -> how many reviews gave it. Always has keys 1..5. */
  distribution: z.object({
    1: z.number().int().nonnegative(),
    2: z.number().int().nonnegative(),
    3: z.number().int().nonnegative(),
    4: z.number().int().nonnegative(),
    5: z.number().int().nonnegative(),
  }),
  /** Sub-rating averages, null where nobody rated that dimension. */
  communicationAverage: z.number().min(1).max(5).nullable(),
  accuracyAverage: z.number().min(1).max(5).nullable(),
  valueAverage: z.number().min(1).max(5).nullable(),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewsListResponseSchema = z.object({
  items: z.array(reviewResponseSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  /**
   * Always present, but `average` is null when there is nothing to average.
   * Carried on the list response so the listing only ever needs one request to
   * render both the headline score and the reviews beneath it.
   */
  summary: reviewSummarySchema,
});

export type ReviewsListResponse = z.infer<typeof reviewsListResponseSchema>;

export const voteReviewRequestSchema = z.object({
  reviewId: cuid,
  value: reviewVoteValueSchema,
});

export type VoteReviewRequest = z.infer<typeof voteReviewRequestSchema>;

export const flagReviewRequestSchema = z.object({
  reviewId: cuid,
  reason: z.string().trim().min(10).max(500),
});

export type FlagReviewRequest = z.infer<typeof flagReviewRequestSchema>;