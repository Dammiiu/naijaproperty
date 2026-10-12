import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { ContactPanel } from '@/components/contact-panel';
import { ListingCardView } from '@/components/listing-card';
import { getListing } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import {
  BADGES,
  amenityHint,
  amenityLabel,
  badgeToneClass,
  formatNaira,
  formatPricePeriod,
} from '@naijaproperty/ui';
import type { Amenity } from '@naijaproperty/contracts';
import { VideoPlayer } from '@/components/video-player';
import { SimilarListings } from '@/components/similar-listings';
import { ReviewsSection } from '@/components/reviews-section';

type Params = Promise<{ id: string }>;

/**
 * Builds the page metadata from the listing itself.
 *
 * The exact address and phone are deliberately absent from the description:
 * Open Graph cards are scraped and cached by third parties, and a title tag that
 * said "3-bed in Lekki, Plot 14B, Surulere" would defeat the reveal gate.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const listing = await getListing(id);
  if (!listing) return { title: 'Listing not found' };

  const where = [
    listing.location.areaName,
    listing.location.lgaName,
    listing.location.stateName,
  ]
    .filter(Boolean)
    .join(', ');

  const price = `${formatNaira(listing.price, { compact: false })}${
    listing.pricePeriod !== 'NONE' ? ` ${formatPricePeriod(listing.pricePeriod).toLowerCase()}` : ''
  }`;

  const title = `${listing.typeLabel} for ${
    listing.kind === 'SALE' ? 'sale' : 'rent'
  } in ${listing.location.areaName ?? listing.location.lgaName}, ${price}`;

  const description = `${listing.bedrooms ? `${listing.bedrooms} bedroom ` : ''}${
    listing.typeLabel.toLowerCase()
  } in ${where}. ${listing.description.slice(0, 120)}`.trim();

  return {
    title,
    description,
    alternates: { canonical: `/listings/${listing.id}` },
    openGraph: {
      type: 'article',
      title,
      description,
      images: listing.coverImageUrl ? [{ url: listing.coverImageUrl }] : undefined,
    },
  };
}

export default async function ListingPage({ params }: { params: Params }) {
  const { id } = await params;

  // The token decides whether the exact address and phone are rendered. Getting
  // this wrong leaks PII, so it is resolved before anything else on the page.
  const token = await getAccessToken();
  const listing = await getListing(id, token);

  if (!listing) notFound();

  const signedIn = token !== null;
  const headerUser = await getHeaderUser();

  const facts: Array<{ label: string; value: string }> = [];
  if (listing.bedrooms !== null) facts.push({ label: 'Bedrooms', value: String(listing.bedrooms) });
  if (listing.bathrooms !== null) facts.push({ label: 'Bathrooms', value: String(listing.bathrooms) });
  if (listing.builtSqm !== null) facts.push({ label: 'Built area', value: `${listing.builtSqm} sqm` });
  if (listing.plotSqm !== null) facts.push({ label: 'Plot size', value: `${listing.plotSqm} sqm` });
  if (listing.minimumStayMonths !== null)
    facts.push({ label: 'Minimum stay', value: `${listing.minimumStayMonths} months` });
  facts.push({ label: 'Type', value: listing.typeLabel });
  facts.push({ label: 'Published', value: relativeDate(listing.publishedAt) });

  return (
    <>
      <SiteHeader active={listing.kind === 'SALE' ? 'sale' : 'rent'} user={headerUser} />

      <main id="main" className="container detail">
        <nav className="detail__crumbs" aria-label="Breadcrumb">
          <a href={`/?kind=${listing.kind}`}>
            {listing.kind === 'SALE' ? 'Properties for sale' : 'Rentals'}
          </a>
          <span aria-hidden="true">/</span>
          <span>{listing.typeLabel}</span>
        </nav>

        <div className="detail__layout">
          <div className="detail__main">
            <Gallery listing={listing} />

            <section className="detail__head">
              <div className="detail__badges">
                {listing.badges.slice(0, 2).map((code) => (
                  <span key={code} className={`badge ${badgeToneClass(code)}`} title={BADGES[code].title}>
                    {BADGES[code].label}
                  </span>
                ))}
              </div>

              <h1 className="detail__title">{listing.title}</h1>

              <p className="detail__price">
                <span className="detail__price-amount">{formatNaira(listing.price, { compact: false })}</span>
                {listing.pricePeriod !== 'NONE' ? (
                  <span className="detail__price-period">{formatPricePeriod(listing.pricePeriod)}</span>
                ) : null}
                {listing.priceNegotiable ? <span className="detail__negotiable">Negotiable</span> : null}
              </p>

              <p className="detail__where">
                {[listing.location.areaName, listing.location.lgaName, listing.location.stateName]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            </section>

            {listing.video ? (
              <section className="detail__section" aria-label="Video walkthrough">
                <h2 className="detail__section-title">Video walkthrough</h2>
                {listing.video.playbackHls ? (
                  <VideoPlayer
                    src={listing.video.playbackHls}
                    poster={listing.video.posterUrl}
                    title={`Walkthrough video for ${listing.title}`}
                  />
                ) : listing.video.posterUrl ? (
                  <div className="detail__video-pending">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={listing.video.posterUrl} alt="Video walkthrough poster" />
                    <p>
                      A walkthrough video was uploaded for this property. Playback becomes available
                      once transcoding finishes.
                    </p>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="detail__section">
              <h2 className="detail__section-title">About this property</h2>
              <p className="detail__description">{listing.description}</p>
            </section>

            {facts.length > 0 ? (
              <section className="detail__section">
                <h2 className="detail__section-title">Key facts</h2>
                <dl className="factgrid">
                  {facts.map((f) => (
                    <div className="factgrid__item" key={f.label}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {listing.amenities.length > 0 ? (
              <section className="detail__section">
                <h2 className="detail__section-title">Features</h2>
                <ul className="amenities">
                  {listing.amenities.map((a) => (
                    <li className="amenities__item" key={a} title={amenityHint(a as Amenity)}>
                      {/* Same vocabulary the filter chips use, so what a person
                          filtered on is what they read on the page. */}
                      {amenityLabel(a as Amenity)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {listing.agencyFee !== null || listing.paymentAdvance !== null ? (
              <section className="detail__section">
                <h2 className="detail__section-title">Payment terms</h2>
                <dl className="factgrid">
                  {listing.paymentAdvance !== null ? (
                    <div className="factgrid__item">
                      <dt>Advance</dt>
                      <dd>{listing.paymentAdvance}% of the rent</dd>
                    </div>
                  ) : null}
                  {/*
                      The fee row is always shown, including when there is none.

                      "Agent fee: not stated" is itself information. A poster who did
                      not commit to a fee is not the same as one who committed to
                      zero, and a renter budgeting a move is exactly the person who
                      needs to tell those apart before making contact. The hero
                      promises nothing is hidden, so silence cannot be the answer.
                    */}
                  <div className="factgrid__item">
                    <dt>Agent fee</dt>
                    <dd>
                      {listing.agencyFee === null ? (
                        <span className="fee--unstated">Not stated by the poster</span>
                      ) : listing.agencyFee === 0 ? (
                        <span className="fee--none">No agent fee</span>
                      ) : (
                        formatNaira(listing.agencyFee, { compact: false })
                      )}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </div>

          <aside className="detail__aside">
            <ContactPanel
              listingId={listing.id}
              signedIn={signedIn}
              isOwner={listing.isOwner}
              revealed={listing.contactRevealed}
              exactAddress={listing.exactAddress}
              ownerPhone={listing.ownerPhone}
              conversationId={listing.conversationId}
            />

            <section className="postercard" aria-label="About the poster">
              <h2 className="postercard__title">Posted by</h2>
              <p className="postercard__name">{listing.poster.displayName}</p>
              <p className="postercard__since">
                Member since {relativeDate(listing.poster.memberSince)}
              </p>

              <ul className="postercard__trust">
                <li className={listing.badges.includes('VERIFIED_OWNER') ? 'is-yes' : 'is-no'}>
                  {listing.badges.includes('VERIFIED_OWNER')
                    ? 'Phone number verified by SMS'
                    : 'Phone number not verified'}
                </li>
                <li className={listing.poster.agencyLicenceVerified ? 'is-yes' : 'is-no'}>
                  {listing.poster.agencyLicenceVerified
                    ? `Licence checked: ${listing.poster.agencyName}`
                    : listing.poster.agencyName
                      ? `Agency: ${listing.poster.agencyName} (licence not checked)`
                      : 'Private owner, not an agency'}
                </li>
              </ul>
            </section>

            <section className="safetynote" aria-label="Safety advice">
              <h2 className="safetynote__title">Before you pay anyone</h2>
              <ul className="safetynote__list">
                <li>Visit the property in person, at least once, in daylight.</li>
                <li>Verify the title document against the land registry record.</li>
                <li>Never pay a "booking fee" to a number you have not met.</li>
                <li>A landlord who refuses to show the property is telling you something.</li>
              </ul>
            </section>
          </aside>
        </div>

        {/*
          Reviews before similar listings.

          Reviews are the credibility signal a buyer is looking for, and a
          "similar properties" carousel is the thing that sends them away. Putting
          reviews second buried them under a carousel whose whole purpose is to
          offer an alternative to this property.
        */}
        <ReviewsSection
          listingId={listing.id}
          signedIn={signedIn}
          userEligibility={signedIn && listing.contactRevealed ? 'REVEALED' : null}
        />

        <SimilarListings listingId={listing.id} />
      </main>

      <SiteFooter />
    </>
  );
}

/**
 * Gallery.
 *
 * The cover is a plain <img> on purpose. Cloudflare Image Transformations derive
 * every width from one stored object, so a single responsive srcset keeps the
 * stored file count at one while still giving phones a small download.
 */
function Gallery({
  listing,
}: {
  listing: Awaited<ReturnType<typeof getListing>> & object;
}) {
  const images = listing.media.filter((m) => m.url);

  if (images.length === 0) {
    return (
      <div
        className="gallery gallery--empty"
        style={
          listing.media[0]?.dominantColor
            ? { backgroundColor: listing.media[0].dominantColor }
            : undefined
        }
      >
        <p>The poster has not uploaded photos for this listing yet.</p>
      </div>
    );
  }

  const [cover, ...rest] = images;

  return (
    <div className="gallery">
      <figure className="gallery__cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cover.url!} alt={listing.title} className="gallery__img" fetchPriority="high" />
      </figure>

      {rest.length > 0 ? (
        <div className="gallery__thumbs">
          {rest.slice(0, 5).map((m) => (
            <figure className="gallery__thumb" key={m.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url!} alt="" loading="lazy" className="gallery__img" />
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "3 days ago" reads better on a listing than an absolute date. */
function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}