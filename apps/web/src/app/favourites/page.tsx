import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { apiFetch, getSessionUser } from '@/lib/session';
import { ListingCardView } from '@/components/listing-card';
import type { ListingCard } from '@naijaproperty/contracts';
import { formatNaira, formatPricePeriod } from '@naijaproperty/ui';

export const metadata: Metadata = {
  title: 'Saved properties',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface Favourite {
  id: string;
  favouriteId: string;
  note: string | null;
  savedAt: string;
  kind: string;
  typeLabel: string;
  title: string;
  price: number;
  pricePeriod: string;
  priceNegotiable: boolean;
  bedrooms: number | null;
  plotSqm: number | null;
  builtSqm: number | null;
  location: { areaName: string | null; lgaName: string; stateName: string };
  coverImageUrl: string | null;
  videoCount: number;
  badges: string[];
  status: string;
  isLive: boolean;
}

export default async function FavouritesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/favourites');

  const [data, headerUser] = await Promise.all([
    apiFetch<{ items: Favourite[] }>('/api/v1/favourites'),
    getHeaderUser(),
  ]);

  const items = data?.items ?? [];
  const live = items.filter((f) => f.isLive);
  const gone = items.filter((f) => !f.isLive);

  return (
    <>
      <SiteHeader user={headerUser} />
      <main id="main" className="container dashboard">
        <header className="dashboard__head">
          <div>
            <h1 className="dashboard__title">Saved properties</h1>
            <p className="dashboard__sub">
              {live.length === 0
                ? 'Properties you save are kept here so you can compare them later.'
                : `${live.length} propert${live.length === 1 ? 'y' : 'ies'} saved.`}
            </p>
          </div>
          <Link className="btn btn--ghost" href="/saved">
            Saved searches
          </Link>
        </header>

        {items.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">Nothing saved yet</h2>
            <p className="empty__body">
              Tap the heart on any property to keep it here. It stays even if the owner re-lists,
              so you can tell whether the new price is better than the old one.
            </p>
            <Link className="btn btn--primary" href="/?kind=RENT">
              Browse rentals
            </Link>
          </div>
        ) : null}

        {live.length > 0 ? (
          <>
            <section className="dashboard__group">
              <h2 className="dashboard__grouptitle">Available</h2>

              {/*
                A comparison table rather than another card grid. Once someone has
                shortlisted properties, the question is no longer "does this look
                nice" but "which of these three is actually better", and that needs
                the rows aligned so the numbers can be scanned down a column.
              */}
              <div className="table-scroll">
                <table className="compare">
                  <thead>
                    <tr>
                      <th scope="col">Property</th>
                      <th scope="col">Price</th>
                      <th scope="col">Where</th>
                      <th scope="col">Beds</th>
                      <th scope="col">Size</th>
                      <th scope="col">Features</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((f) => (
                      <tr key={f.id}>
                        <th scope="row" className="compare__prop">
                          <Link href={`/listings/${f.id}`}>{f.title}</Link>
                          <span className="compare__sub">{f.typeLabel}</span>
                        </th>
                        <td className="is-numeric">
                          {formatNaira(f.price, { compact: false })}
                          {f.pricePeriod !== 'NONE' ? (
                            <span className="compare__sub">
                              {formatPricePeriod(f.pricePeriod as never)}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {[f.location.areaName, f.location.lgaName].filter(Boolean).join(', ')}
                        </td>
                        <td className="is-numeric">{f.bedrooms ?? 'None'}</td>
                        <td className="is-numeric">
                          {f.builtSqm ? `${f.builtSqm} sqm built` : f.plotSqm ? `${f.plotSqm} sqm plot` : 'None'}
                        </td>
                        <td>{f.badges.length > 0 ? f.badges.length : 'None'}</td>
                        <td>
                          <Link className="btn btn--tiny btn--ghost" href={`/listings/${f.id}`}>
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}

        {gone.length > 0 ? (
          <section className="dashboard__group">
            <h2 className="dashboard__grouptitle">No longer available</h2>
            <p className="dashboard__grouphint">
              Kept so you can tell whether something you liked is genuinely gone, rather than
              quietly disappearing from your shortlist.
            </p>
            <ul className="savedlist">
              {gone.map((f) => (
                <li key={f.id} className="savedrow">
                  <div className="savedrow__body">
                    <h2 className="savedrow__name">{f.title}</h2>
                    <p className="savedrow__meta">
                      {f.status.replace(/_/g, ' ').toLowerCase()} ·{' '}
                      {formatNaira(f.price, { compact: false })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}