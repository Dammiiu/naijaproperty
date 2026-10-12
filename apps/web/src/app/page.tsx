import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { FilterBar } from '@/components/filter-bar';
import { ListingCardView, ListingCardSkeleton } from '@/components/listing-card';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { SaveSearchButton } from '@/components/save-search-button';
import { getListingTypes, getStates, searchListings } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { getFavourites } from '@/lib/favourites';
import { STATES } from '@/data/reference-states';
import type { ListingKind } from '@naijaproperty/contracts';

export const metadata: Metadata = {
  title: 'Property for rent and sale in Nigeria',
  description:
    'Search homes, rooms, flats and land across all 36 states and the FCT. Renters and buyers see separate results, so rent listings never mix with listings for sale.',
  alternates: { canonical: '/' },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Query params arrive as either a string or an array; search wants an array. */
function list(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length ? arr : undefined;
}

function num(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function flag(value: string | string[] | undefined): boolean | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  return raw === 'true' ? true : undefined;
}

/**
 * Browsing requires no account. This page is the SEO surface, so it renders on
 * the server and must never include a phone number or an exact address, that is
 * enforced by the API's public column list, not by anything in this component.
 */
export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const resolved = await searchParams;
  const kind = ((resolved.kind as string) ?? 'RENT').toUpperCase() as ListingKind;
  const safeKind: ListingKind = kind === 'SALE' ? 'SALE' : 'RENT';

  const query: Parameters<typeof searchListings>[0] = {
    kind: safeKind,
    q: (resolved.q as string) || undefined,
    type: list(resolved.type),
    stateCode: list(resolved.stateCode),
    pricePeriod: list(resolved.pricePeriod),
    bedroomsMin: num(resolved.bedroomsMin),
    minPrice: num(resolved.minPrice),
    maxPrice: num(resolved.maxPrice),
    hasVideo: flag(resolved.hasVideo),
    hasVerifiedTitle: flag(resolved.hasVerifiedTitle),
    verifiedOnly: flag(resolved.verifiedOnly),
    sort: (resolved.sort as string) || undefined,
    limit: 24,
  };

  const [result, types, states, token, headerUser] = await Promise.all([
    searchListings(query),
    getListingTypes(safeKind),
    getStates(),
    getAccessToken(),
    getHeaderUser(),
  ]);

  // Saving a search or a property needs an account, so both controls need to
  // know whether to offer the flow or send the visitor to sign in first.
  const signedIn = token !== null;

  /*
   * Which of these results are already shortlisted.
   *
   * Fetched after the results rather than inside the same Promise.all, because it
   * needs the ids that came back. One batched request for the page beats 24
   * individual checks, and it is skipped entirely for anonymous visitors.
   */
  const favourites = signedIn ? await getFavourites(result.items.map((i) => i.id)) : new Set<string>();

  const stateList = states.length ? states : STATES.map((s) => ({ code: s.code, name: s.name }));
  const total = result.totalEstimate;

  return (
    <>
      <SiteHeader active={safeKind === 'SALE' ? 'sale' : 'rent'} user={headerUser} />

      <main id="main">
        <section className="hero">
          <div className="container hero__inner">
            <div className="hero__lead">
              <p className="hero__eyebrow">
                {safeKind === 'SALE' ? 'Homes, flats and land for sale' : 'Homes and rooms for rent'}
              </p>
              <h1 className="hero__title">
                {safeKind === 'SALE'
                  ? 'Property for sale, listed by the people who own it'
                  : 'Find a home to rent without the runaround'}
              </h1>
              <p className="hero__subtitle">
                {safeKind === 'SALE'
                  ? 'Browse homes, flats and land across Nigeria. Every listing is checked by our team before anyone sees it.'
                  : 'Rentals from owners and registered agents. See the real price, the real photos and who is actually letting the place before you pay anyone a cent.'}
              </p>

              {/*
                The promise gets its own treatment because it is the reason to
                trust this site over the alternatives. Buried as body text it reads
                like marketing; stated as a standing commitment it reads like a
                rule the site enforces.
              */}
              <p className="hero__promise">
                <span className="hero__promise-label">Our promise</span>
                No agent fee is hidden in a listing. If a poster charges one, they say so on
                the listing, and you can see that before you make contact.
              </p>

              {/*
                Counts live in the left column, under the promise.

                They were in the right-hand panel, which is taller than the copy,
                so the left column ended two hundred pixels early and left a
                visible void beside it. Moving them across balances the two
                columns and puts the numbers next to the claim they support.

                Read from the result already on screen rather than hardcoded, so
                they stay true as the database grows.
              */}
              <dl className="hero__stats">
                <div className="hero__stat">
                  <dt>Listings live</dt>
                  <dd>{total.toLocaleString('en-NG')}</dd>
                </div>
                <div className="hero__stat">
                  <dt>States and FCT</dt>
                  <dd>37</dd>
                </div>
                <div className="hero__stat">
                  <dt>Cost to list</dt>
                  <dd>Free</dd>
                </div>
              </dl>
            </div>

            {/*
              A concrete "why here" panel instead of more marketing copy. Three
              claims a visitor can actually check on this page, which is the point:
              the rent/sale split is the current tab, the agent fee is on every
              card, and the video badge means a walkthrough exists.
            */}
            <aside className="hero__panel" aria-label="How this site works">
              <h2 className="hero__panel-title">What makes this different</h2>
              <ul className="hero__points">
                <li className="hero__point">
                  <span className="hero__point-title">Rent and sale never mix</span>
                  <span className="hero__point-body">
                    You are looking at {safeKind === 'SALE' ? 'properties for sale' : 'homes to rent'}
                    . Switching tabs switches results, so nobody wastes time on a listing that
                    was never available.
                  </span>
                </li>
                <li className="hero__point">
                  <span className="hero__point-title">Every fee is stated up front</span>
                  <span className="hero__point-body">
                    A card says the agency fee, or says there is none, or says the poster never
                    said. Silence is treated as unknown, not as free.
                  </span>
                </li>
                <li className="hero__point">
                  <span className="hero__point-title">Reviewed before it goes live</span>
                  <span className="hero__point-body">
                    Nothing appears in these results until a person has checked it. Walkthrough
                    videos are listed as a badge, so you can filter for them.
                  </span>
                </li>
              </ul>
            </aside>
          </div>
        </section>

        <div className="container">
          <Suspense fallback={<div className="filters__placeholder" />}>
            <FilterBar kind={safeKind} types={types} states={stateList} />
          </Suspense>

          <section className="results" aria-label="Listings">
            <div className="results__header">
              <p className="results__status" role="status">
                {total === 0
                  ? 'No listings match those filters'
                  : `${total.toLocaleString('en-NG')} ${total === 1 ? 'listing' : 'listings'} for ${safeKind === 'SALE' ? 'sale' : 'rent'}`}
                {result.nextCursor ? ', showing the first page' : ''}
              </p>

              <SaveSearchButton signedIn={signedIn} />
            </div>

            {result.items.length === 0 ? (
              <EmptyState kind={safeKind} />
            ) : (
              <div className="grid">
                {result.items.map((listing) => (
                  <ListingCardView
                    key={listing.id}
                    listing={listing}
                    signedIn={signedIn}
                    isFavourite={favourites.has(listing.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

/**
 * Empty state has to be actionable. "No results" with no next step is where
 * browsing funnels die, so this names the two things most likely to be wrong and
 * links to the unfiltered view of the same kind.
 */
function EmptyState({ kind }: { kind: ListingKind }) {
  const other = kind === 'RENT' ? 'sale' : 'rent';
  return (
    <div className="empty">
      <h2 className="empty__title">Nothing matches those filters yet</h2>
      <p className="empty__body">
        Either the price range is too tight or that combination has not been listed yet.
        {kind === 'RENT'
          ? ' Rents in this market are often quoted yearly, so try switching the period.'
          : ''}
      </p>
      <ul className="empty__actions">
        <li>
          <Link className="btn btn--primary" href={`/?kind=${kind}`}>
            Clear all filters
          </Link>
        </li>
        <li>
          <Link className="btn btn--ghost" href={`/?kind=${other}`}>
            Browse {other === 'sale' ? 'properties for sale' : 'rentals'} instead
          </Link>
        </li>
        <li>
          <Link className="btn btn--ghost" href="/post">
            List your own property
          </Link>
        </li>
      </ul>
    </div>
  );
}

/** Carries the active filter set into the saved-search flow. */
function buildSaveHref(
  params: Record<string, string | string[] | undefined>,
  kind: ListingKind,
): string {
  const qs = new URLSearchParams();
  qs.set('kind', kind);
  for (const [key, value] of Object.entries(params)) {
    if (key === 'kind' || value === undefined || value === '') continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }
  return `/saved/new?${qs.toString()}`;
}
