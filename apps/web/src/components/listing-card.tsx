/**
 * Listing card.
 *
 * Photo-forward, one price, and a hard cap of two badges. The incumbent market
 * stacks up to seven promotional labels onto a single card, which trains users
 * to ignore badges entirely; here every badge is a verifiable claim.
 */

import type { ListingCard } from '@naijaproperty/contracts';
import { BADGES, badgeToneClass, formatNaira, formatPricePeriod } from '@naijaproperty/ui';
import { FavouriteButton } from './favourite-button';

export function ListingCardView({
  listing,
  signedIn = false,
  isFavourite = false,
}: {
  listing: ListingCard;
  /** Whether the viewer has a session, so the heart can prompt for one. */
  signedIn?: boolean;
  /** Whether this listing is already shortlisted. */
  isFavourite?: boolean;
}) {
  const {
    id,
    title,
    price,
    pricePeriod,
    priceNegotiable,
    agencyFee,
    typeLabel,
    location,
    bedrooms,
    bathrooms,
    coverImageUrl,
    videoCount,
    badges,
    ratingAverage = null,
    reviewCount = 0,
  } = listing;

  const badgeList = badges.slice(0, 2);

  return (
    <article className="card">
      {/*
       * Sibling of the card link, not a descendant. A button inside an anchor is
       * invalid HTML and browsers disagree about whether the click navigates, so
       * saving a property would take the user off the page instead.
       */}
      <FavouriteButton
        listingId={id}
        initialSaved={isFavourite}
        signedIn={signedIn}
        compact
      />

      <a href={`/listings/${id}`} className="card__link">
        <div className="card__media">
          {coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="card__image"
            />
          ) : (
            <div className="card__placeholder" aria-hidden="true" />
          )}

          {videoCount > 0 ? (
            <span className="card__video" aria-label={`${videoCount} video tour available`}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 5.5v13l11-6.5-11-6.5Z"
                />
              </svg>
              Video
            </span>
          ) : null}
        </div>

        <div className="card__body">
          <div className="card__badges">
            {badgeList.map((code) => (
              <span
                key={code}
                className={`badge ${badgeToneClass(code)}`}
                title={BADGES[code].title}
              >
                {BADGES[code].label}
              </span>
            ))}
          </div>

          <h3 className="card__price">
            <span className="visually-hidden">
              {formatNaira(price, { compact: false })}
            </span>
            <span aria-hidden="true">{formatNaira(price, { compact: true })}</span>
            {pricePeriod !== 'NONE' ? (
              <span className="card__period">{formatPricePeriod(pricePeriod)}</span>
            ) : null}
            {priceNegotiable ? <span className="card__negotiable">Negotiable</span> : null}

            {/*
              Reputation, beside the price.

              Placed on the price line rather than below the title because this
              is the number a buyer scans for, and putting it next to the money
              makes the comparison they are actually making: what am I paying,
              and has anyone had a bad experience.

              Only rendered when there is at least one review. Showing an empty
              star row on an unreviewed listing would spend the visual weight
              of the badge on the majority of cards and make "no reviews yet"
              read as "rated poorly", which is the opposite of the truth.

              The tone is a genuine warning below 3, not decoration. A landlord
              with three 1-star reviews should be visibly flagged in the results
              grid, so a buyer rules them out before spending the click.
            */}
            {ratingAverage !== null && reviewCount > 0 ? (
              <span
                className={`card__rating ${
                  ratingAverage < 3 ? 'is-poor' : ratingAverage < 4 ? 'is-mixed' : 'is-good'
                }`}
                title={`${ratingAverage} out of 5 from ${reviewCount} review${
                  reviewCount === 1 ? '' : 's'
                }`}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45 6.19 20.5l1.1-6.47L2.6 9.45l6.5-.95L12 2.6Z"
                  />
                </svg>
                <span aria-hidden="true">{ratingAverage.toFixed(1)}</span>
                <span className="visually-hidden">
                  Rated {ratingAverage} out of 5 from {reviewCount} review
                  {reviewCount === 1 ? '' : 's'}
                </span>
                <span className="card__rating-count" aria-hidden="true">
                  ({reviewCount})
                </span>
              </span>
            ) : null}
          </h3>

          <p className="card__title">{title}</p>

          <p className="card__type">{typeLabel}</p>

          {/*
           * Location as a hierarchy rather than one run-on string.
           *
           * "GRA Ikeja, Ikeja, Lagos" flattens three different levels into one
           * line, and the reader has to guess which part is the neighbourhood and
           * which is the state. Putting the area first in its own weight, with LGA
           * and state below, answers "where exactly is this" at a glance and still
           * stops at area level. The street address needs a reveal.
           */}
          <p className="card__loc">
            {location.areaName ? (
              <span className="card__area">{location.areaName}</span>
            ) : (
              <span className="card__area">{location.lgaName}</span>
            )}
            <span className="card__locsub">
              {location.areaName ? `${location.lgaName}, ` : ''}
              {location.stateName}
            </span>
          </p>

          {/*
           * The fee, stated plainly, on every card.
           *
           * This is the promise the hero makes, so it cannot be something the user
           * has to go looking for. Three states, because they mean different
           * things to someone budgeting a move: none charged, a number charged, or
           * the poster did not say (which is not the same as none).
           */}
          <p className={`card__fee ${agencyFee === null ? 'is-unstated' : ''}`}>
            {agencyFee === null ? (
              'Fee not stated'
            ) : agencyFee === 0 ? (
              'No agent fee'
            ) : (
              <>
                {formatNaira(agencyFee, { compact: true })} agent fee
              </>
            )}
          </p>

          {bedrooms !== null || bathrooms !== null ? (
            <p className="card__facts">
              {bedrooms !== null ? <span>{bedrooms} bed</span> : null}
              {bathrooms !== null ? <span>{bathrooms} bath</span> : null}
            </p>
          ) : null}
        </div>
      </a>
    </article>
  );
}

export function ListingCardSkeleton() {
  return (
    <article className="card card--skeleton" aria-hidden="true">
      <div className="card__media">
        <div className="card__placeholder card__placeholder--shimmer" />
      </div>
      <div className="card__body">
        <div className="skeleton-line skeleton-line--badge" />
        <div className="skeleton-line skeleton-line--price" />
        <div className="skeleton-line" />
        <div className="skeleton-line skeleton-line--short" />
      </div>
    </article>
  );
}
