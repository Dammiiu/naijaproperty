import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { DeleteSavedSearch } from './delete-button';
import { apiFetch, getSessionUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Saved searches',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface SavedSearch {
  id: string;
  name: string;
  query: Record<string, unknown>;
  cadence: string;
  lastRunAt: string | null;
  newMatches: number;
}

export default async function SavedSearchesPage() {
  /*
   * Saved searches are strictly per-user, so an anonymous visitor has nothing to
   * see. Redirect rather than rendering an empty page: showing "you have no
   * saved searches" to someone who could never have any is a confusing way to
   * discover they are signed out.
   */
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/saved');

  const data = await apiFetch<{ items: SavedSearch[] }>('/api/v1/saved-searches');
  const items = data?.items ?? [];

  return (
    <>
      <SiteHeader user={await getHeaderUser()} />
      <main id="main" className="container dashboard">
        <header className="dashboard__head">
          <div>
            <h1 className="dashboard__title">Saved searches</h1>
            <p className="dashboard__sub">
              We re-run each search and show you what is new. A saved search keeps working after a
              landlord re-lists, which is more useful than bookmarking one card.
            </p>
          </div>
        </header>

        {items.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">You have not saved a search yet</h2>
            <p className="empty__body">
              Run a search, then use &ldquo;Save this search&rdquo; above the results. We will keep
              watching that filter for you.
            </p>
            <Link className="btn btn--primary" href="/">
              Start searching
            </Link>
          </div>
        ) : (
          <ul className="savedlist">
            {items.map((s) => (
              <li key={s.id} className="savedrow">
                <div className="savedrow__body">
                  <h2 className="savedrow__name">{s.name}</h2>
                  <p className="savedrow__query">{describe(s.query)}</p>
                  <p className="savedrow__meta">
                    {s.newMatches} listing{s.newMatches === 1 ? '' : 's'} found
                    {s.lastRunAt
                      ? ` · last checked ${new Date(s.lastRunAt).toISOString().slice(0, 10)}`
                      : ' · not checked yet'}
                  </p>
                </div>
                <div className="savedrow__actions">
                  <Link className="btn btn--primary" href={hrefFor(s.query)}>
                    View results
                  </Link>
                  <DeleteSavedSearch id={s.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

/** Turns the stored query back into a browse URL. */
function hrefFor(query: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const v of value) qs.append(key, String(v));
    else qs.set(key, String(value));
  }
  return `/?${qs.toString()}`;
}

/** Human summary of a stored query, so a list of searches is readable. */
function describe(query: Record<string, unknown>): string {
  const parts: string[] = [];
  if (query.q) parts.push(`"${String(query.q)}"`);
  if (Array.isArray(query.type) && query.type.length) parts.push(query.type.join(', '));
  if (Array.isArray(query.stateCode) && query.stateCode.length) parts.push(query.stateCode.join(', '));
  if (query.bedroomsMin) parts.push(`${String(query.bedroomsMin)}+ bed`);
  if (query.minPrice || query.maxPrice) {
    parts.push(`₦${Number(query.minPrice ?? 0).toLocaleString()} to ${query.maxPrice ? `₦${Number(query.maxPrice).toLocaleString()}` : 'any'}`);
  }
  if (query.hasVideo) parts.push('has video');
  if (query.verifiedOnly) parts.push('verified owner only');
  return parts.length ? parts.join(' · ') : 'All listings';
}