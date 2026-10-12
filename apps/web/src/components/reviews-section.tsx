'use client';

/**
 * Reviews section for a listing.
 *
 * Fetches and displays reviews with pagination, vote buttons, and a form to
 * submit a new review. All interactions go through the BFF routes so the
 * browser never sees the API host.
 */

import { useEffect, useState } from 'react';
import { formatNaira } from '@naijaproperty/ui';
import type { ReviewResponse, ReviewsListResponse, ReviewSummary } from '@naijaproperty/contracts';

const STAR_FILLED = '★';
const STAR_EMPTY = '☆';

function Stars({ rating, max = 5, size = 16 }: { rating: number; max?: number; size?: number }) {
  return (
    <span className="review__stars" style={{ fontSize: size }}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < rating ? 'filled' : ''}>
          {STAR_FILLED}
        </span>
      ))}
    </span>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = useState('');

  useEffect(() => {
    const then = new Date(iso).getTime();
    const days = Math.floor((Date.now() - then) / 86_400_000);
    if (days <= 0) setText('today');
    else if (days === 1) setText('yesterday');
    else if (days < 30) setText(`${days} days ago`);
    else if (days < 365) setText(`${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? '' : 's'} ago`);
    else setText(`${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? '' : 's'} ago`);
  }, [iso]);

  return <time dateTime={iso}>{text}</time>;
}

interface ReviewsSectionProps {
  listingId: string;
  signedIn: boolean;
  userEligibility?: 'REVEALED' | 'STAY_RECORDED' | null;
}

export function ReviewsSection({ listingId, signedIn, userEligibility = null }: ReviewsSectionProps) {
  const [reviews, setReviews] = useState<ReviewResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // New review form state
  const [ratingOverall, setRatingOverall] = useState(5);
  const [ratingCommunication, setRatingCommunication] = useState<number | null>(null);
  const [ratingAccuracy, setRatingAccuracy] = useState<number | null>(null);
  const [ratingValue, setRatingValue] = useState<number | null>(null);
  const [body, setBody] = useState('');

  async function fetchReviews(reset = false) {
    if (reset) {
      setLoading(true);
      setCursor(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      params.set('limit', '10');

      const res = await fetch(`/api/listings/${listingId}/reviews?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load reviews');

      const data: ReviewsListResponse = await res.json();
      if (reset) {
        setReviews(data.items);
      } else {
        setReviews((prev) => [...prev, ...data.items]);
      }
      setCursor(data.nextCursor);
      setTotalCount(data.totalCount);

      /*
       * The summary is taken from the reset page only, never a later one.
       *
       * It is an aggregate over every published review, so it does not change as
       * the reader pages through the list. Storing it on a paginated fetch would
       * be harmless today but is the kind of thing that quietly starts drifting
       * once the endpoint shape changes, so it is pinned deliberately.
       */
      if (reset) setSummary(data.summary);
    } catch (err) {
      console.error('Failed to load reviews:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    fetchReviews(true);
  }, [listingId]);

  async function handleVote(reviewId: string, value: 1 | -1) {
    try {
      const res = await fetch(`/api/reviews/${reviewId}/vote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error('Failed to vote');

      const data = await res.json();
      setReviews((prev) =>
        prev.map((r) =>
          r.id === reviewId
            ? { ...r, helpfulCount: data.helpfulCount, notHelpfulCount: data.notHelpfulCount, userVote: data.userVote }
            : r,
        ),
      );
    } catch (err) {
      console.error('Vote failed:', err);
    }
  }

  async function handleFlag(reviewId: string) {
    const reason = prompt('Why are you flagging this review? (min 10 chars)');
    if (!reason || reason.length < 10) return;

    try {
      const res = await fetch(`/api/reviews/${reviewId}/flag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error('Failed to flag');

      setReviews((prev) =>
        prev.map((r) =>
          r.id === reviewId ? { ...r, status: 'FLAGGED' } : r,
        ),
      );
      alert('Review flagged for moderation. Thank you.');
    } catch (err) {
      console.error('Flag failed:', err);
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!signedIn) {
      setFormError('You must be signed in to write a review');
      return;
    }
    if (!userEligibility) {
      setFormError('You are not eligible to review this listing. You must have either revealed the contact or completed a verified stay.');
      return;
    }
    if (body.trim().length < 50) {
      setFormError('Your review must be at least 50 characters');
      return;
    }

    try {
      const res = await fetch(`/api/listings/${listingId}/reviews/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ratingOverall,
          ratingCommunication: ratingCommunication ?? undefined,
          ratingAccuracy: ratingAccuracy ?? undefined,
          ratingValue: ratingValue ?? undefined,
          body: body.trim(),
          eligibility: userEligibility,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error?.message || 'Failed to submit review');
      }

      // Reset form and reload reviews
      setShowForm(false);
      setRatingOverall(5);
      setRatingCommunication(null);
      setRatingAccuracy(null);
      setRatingValue(null);
      setBody('');
      fetchReviews(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit review');
    }
  }

  if (loading && reviews.length === 0) {
    return (
      <section className="reviews" aria-labelledby="reviews-heading">
        <div className="reviews__skeleton" aria-hidden="true" />
      </section>
    );
  }

  return (
    <section className="reviews" aria-labelledby="reviews-heading">
      <header className="reviews__header">
        <h2 id="reviews-heading" className="reviews__title">
          Reviews <span className="reviews__count">({totalCount})</span>
        </h2>
        {signedIn && userEligibility && !showForm && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowForm(true)}>
            Write a review
          </button>
        )}
      </header>

      {/*
        Reputation summary.

        This is the credibility the whole section exists to produce. A list of
        reviews with no headline number leaves the reader to average three
        reviews in their head, which they will not do, so the section reads as
        decorative. The average, the distribution and the three sub-scores give
        the shape of the reputation at a glance: a landlord can be honest and
        communicative while still being a bad deal, and that distinction is only
        visible in the sub-scores.

        Rendered only when there is at least one review. A listing with no track
        record has to say "not yet reviewed" rather than render a zero, which
        would read as the worst landlord on the site.
      */}
      {summary && summary.count > 0 && summary.average !== null ? (
        <div className="reviews__summary">
          <div className="reviews__score">
            <p
              className={`reviews__score-value ${
                summary.average < 3 ? 'is-poor' : summary.average < 4 ? 'is-mixed' : 'is-good'
              }`}
            >
              {summary.average.toFixed(1)}
              <span className="reviews__score-max">/5</span>
            </p>
            <Stars rating={Math.round(summary.average)} size={15} />
            <p className="reviews__score-count">
              {summary.count} review{summary.count === 1 ? '' : 's'}
            </p>
          </div>

          <ul className="reviews__bars" role="list">
            {([5, 4, 3, 2, 1] as const).map((star) => {
              const n = summary.distribution[star] ?? 0;
              const pct = summary.count > 0 ? (n / summary.count) * 100 : 0;
              return (
                <li key={star} className="reviews__bar">
                  <span className="reviews__bar-label">{star}</span>
                  <span className="reviews__bar-track">
                    <span
                      className="reviews__bar-fill"
                      style={{ width: `${pct}%` }}
                      role="img"
                      aria-label={`${n} ${star}-star review${n === 1 ? '' : 's'}`}
                    />
                  </span>
                  <span className="reviews__bar-n">{n}</span>
                </li>
              );
            })}
          </ul>

          {/*
            Sub-scores, only when reviewers actually filled them in. They are
            optional in the form on purpose: forcing them makes people give a
            number they do not have, which is worse data than no data.
          */}
          {summary.communicationAverage !== null ||
          summary.accuracyAverage !== null ||
          summary.valueAverage !== null ? (
            <dl className="reviews__subscores">
              {summary.communicationAverage !== null ? (
                <div className="reviews__subscore">
                  <dt>Communication</dt>
                  <dd>{summary.communicationAverage.toFixed(1)}</dd>
                </div>
              ) : null}
              {summary.accuracyAverage !== null ? (
                <div className="reviews__subscore">
                  <dt>Accuracy</dt>
                  <dd>{summary.accuracyAverage.toFixed(1)}</dd>
                </div>
              ) : null}
              {summary.valueAverage !== null ? (
                <div className="reviews__subscore">
                  <dt>Value</dt>
                  <dd>{summary.valueAverage.toFixed(1)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}

      {showForm && (
        <form className="review-form" onSubmit={submitReview}>
          <h3 className="review-form__title">Write your review</h3>

          <div className="review-form__group">
            <label className="review-form__label">Overall rating</label>
            <div className="review-form__stars" role="radiogroup" aria-label="Overall rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={ratingOverall === n}
                  className={`review-form__star ${ratingOverall >= n ? 'filled' : ''}`}
                  onClick={() => setRatingOverall(n)}
                >
                  {STAR_FILLED}
                </button>
              ))}
            </div>
          </div>

          <div className="review-form__group">
            <label className="review-form__label">Communication <span className="review-form__optional">(optional)</span></label>
            <div className="review-form__stars" role="radiogroup" aria-label="Communication rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={ratingCommunication === n}
                  className={`review-form__star ${ratingCommunication !== null && ratingCommunication >= n ? 'filled' : ''}`}
                  onClick={() => setRatingCommunication(ratingCommunication === n ? null : n)}
                >
                  {STAR_FILLED}
                </button>
              ))}
              {ratingCommunication === null && <span className="review-form__clear" onClick={() => setRatingCommunication(null)}>Clear</span>}
            </div>
          </div>

          <div className="review-form__group">
            <label className="review-form__label">Accuracy <span className="review-form__optional">(optional)</span></label>
            <div className="review-form__stars" role="radiogroup" aria-label="Accuracy rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={ratingAccuracy === n}
                  className={`review-form__star ${ratingAccuracy !== null && ratingAccuracy >= n ? 'filled' : ''}`}
                  onClick={() => setRatingAccuracy(ratingAccuracy === n ? null : n)}
                >
                  {STAR_FILLED}
                </button>
              ))}
              {ratingAccuracy === null && <span className="review-form__clear" onClick={() => setRatingAccuracy(null)}>Clear</span>}
            </div>
          </div>

          <div className="review-form__group">
            <label className="review-form__label">Value for money <span className="review-form__optional">(optional)</span></label>
            <div className="review-form__stars" role="radiogroup" aria-label="Value rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={ratingValue === n}
                  className={`review-form__star ${ratingValue !== null && ratingValue >= n ? 'filled' : ''}`}
                  onClick={() => setRatingValue(ratingValue === n ? null : n)}
                >
                  {STAR_FILLED}
                </button>
              ))}
              {ratingValue === null && <span className="review-form__clear" onClick={() => setRatingValue(null)}>Clear</span>}
            </div>
          </div>

          <div className="review-form__group">
            <label htmlFor="review-body" className="review-form__label">
              Your experience <span className="review-form__required">*</span>
            </label>
            <textarea
              id="review-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              minLength={50}
              maxLength={4000}
              rows={6}
              className="review-form__textarea"
              placeholder="Describe your experience with this property and the landlord/agent. What did you like? What could be better? (min 50 characters)"
              required
            />
            <p className="review-form__char-count">{body.length}/4000</p>
          </div>

          {formError && <p className="review-form__error" role="alert">{formError}</p>}

          <div className="review-form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary">
              Submit review
            </button>
          </div>
        </form>
      )}

      <ul className="reviews__list" role="list">
        {reviews.length === 0 ? (
          /*
           * The empty state has to explain WHY there are no reviews and what the
           * reader would have to do to add one.
           *
           * "Be the first to write one" is a dead end: eligibility is tied to a
           * real contact reveal or a confirmed stay, so most readers cannot act
           * on it and most had no idea the rule existed. Stating the rule here is
           * also what makes the gate defensible rather than arbitrary.
           */
          <li className="reviews__empty">
            <p className="reviews__empty-title">No reviews yet</p>
            {userEligibility ? (
              <>
                <p>
                  Nobody who has dealt with this property has written about it yet. If you
                  have viewed it or stayed here, yours would be the first.
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setShowForm(true)}
                >
                  Write the first review
                </button>
              </>
            ) : signedIn ? (
              <p>
                You can review this property once you have viewed it or stayed here. We
                only accept reviews from people who actually dealt with the property,
                which is what keeps them worth reading.
              </p>
            ) : (
              <p>
                Sign in to review this property. Reviews are only accepted from people who
                have viewed it or stayed here, which is what keeps them worth reading.
              </p>
            )}
          </li>
        ) : (
          reviews.map((review) => (
            <li key={review.id} className="review">
              <header className="review__header">
                <div className="review__author">
                  <span className="review__name">{review.authorDisplayName}</span>
                  <span className={`review__verification review__verification--${review.authorVerificationTier.toLowerCase()}`}>
                    {review.authorVerificationTier === 'PHONE_VERIFIED' ? '📱 Verified' :
                     review.authorVerificationTier === 'DOCUMENT_VERIFIED' ? '📄 Verified' : 'Unverified'}
                  </span>
                </div>
                <RelativeTime iso={review.createdAt} />
              </header>

              <div className="review__ratings">
                <div className="review__rating-row">
                  <span className="review__rating-label">Overall</span>
                  <Stars rating={review.ratingOverall} size={14} />
                </div>
                {review.ratingCommunication !== null && review.ratingCommunication !== undefined && (
                  <div className="review__rating-row">
                    <span className="review__rating-label">Communication</span>
                    <Stars rating={review.ratingCommunication} size={14} />
                  </div>
                )}
                {review.ratingAccuracy !== null && review.ratingAccuracy !== undefined && (
                  <div className="review__rating-row">
                    <span className="review__rating-label">Accuracy</span>
                    <Stars rating={review.ratingAccuracy} size={14} />
                  </div>
                )}
                {review.ratingValue !== null && review.ratingValue !== undefined && (
                  <div className="review__rating-row">
                    <span className="review__rating-label">Value</span>
                    <Stars rating={review.ratingValue} size={14} />
                  </div>
                )}
              </div>

              <p className="review__body">{review.body}</p>

              <footer className="review__footer">
                <div className="review__votes">
                  <button
                    type="button"
                    className={`review__vote ${review.userVote === 1 ? 'active' : ''}`}
                    onClick={() => handleVote(review.id, 1)}
                    aria-label={review.userVote === 1 ? 'Remove helpful vote' : 'Mark as helpful'}
                    aria-pressed={review.userVote === 1}
                  >
                    <span className="review__vote-icon">👍</span>
                    <span className="review__vote-count">{review.helpfulCount}</span>
                  </button>
                  <button
                    type="button"
                    className={`review__vote ${review.userVote === -1 ? 'active' : ''}`}
                    onClick={() => handleVote(review.id, -1)}
                    aria-label={review.userVote === -1 ? 'Remove not helpful vote' : 'Mark as not helpful'}
                    aria-pressed={review.userVote === -1}
                  >
                    <span className="review__vote-icon">👎</span>
                    <span className="review__vote-count">{review.notHelpfulCount}</span>
                  </button>
                </div>

                {signedIn && review.userVote === null && (
                  <button
                    type="button"
                    className="review__flag"
                    onClick={() => handleFlag(review.id)}
                    aria-label="Flag this review"
                  >
                    Flag
                  </button>
                )}
              </footer>
            </li>
          )))}
        </ul>

      {cursor && !loadingMore && (
        <button
          type="button"
          className="btn btn--ghost btn--block reviews__load-more"
          onClick={() => fetchReviews(false)}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading...' : 'Load more reviews'}
        </button>
      )}
    </section>
  );
}