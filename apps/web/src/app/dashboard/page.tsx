import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { ResubmitButton } from './resubmit-button';
import { apiFetch, getSessionUser } from '@/lib/session';
import { formatNaira, formatPricePeriod } from '@naijaproperty/ui';

export const metadata: Metadata = {
  title: 'Your listings',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface MyListing {
  id: string;
  kind: string;
  typeLabel: string;
  title: string;
  status: string;
  price: number;
  pricePeriod: string;
  location: { areaName: string | null; lgaName: string; stateName: string };
  coverImageUrl: string | null;
  exactAddress: string | null;
  photoCount: number;
  revealCount: number;
  conversationCount: number;
  viewCount: number;
  createdAt: string;
  publishedAt: string | null;
  rejectionReason: string | null;
  slaDueAt: string | null;
  events: Array<{ action: string; reasonCode: string | null; note: string | null; at: string }>;
}

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/dashboard');

  const data = await apiFetch<{ items: MyListing[] }>('/api/v1/my/listings');
  const items = data?.items ?? [];

  // Grouped by what the poster needs to do next, not by a database enum. A
  // dashboard that lists everything in one undifferentiated table makes the
  // poster do the triage themselves.
  const needsAction = items.filter(
    (l) => l.status === 'CHANGES_REQUESTED' || l.status === 'DRAFT' || l.status === 'REJECTED',
  );
  const inReview = items.filter((l) => l.status === 'PENDING_REVIEW');
  const live = items.filter((l) => l.status === 'LIVE');
  const other = items.filter(
    (l) => !['CHANGES_REQUESTED', 'DRAFT', 'REJECTED', 'PENDING_REVIEW', 'LIVE'].includes(l.status),
  );

  return (
    <>
      <SiteHeader user={await getHeaderUser()} />
      <main id="main" className="container dashboard">
        <header className="dashboard__head">
          <div>
            <h1 className="dashboard__title">Your listings</h1>
            <p className="dashboard__sub">
              Signed in as {user.displayName}. {items.length} listing{items.length === 1 ? '' : 's'}.
            </p>
          </div>
          <Link className="btn btn--primary" href="/post">
            Post a property
          </Link>
        </header>

        {items.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">You have not posted anything yet</h2>
            <p className="empty__body">
              Post your first property and it will be reviewed by our team before it goes live, usually
              within a few hours.
            </p>
            <Link className="btn btn--primary" href="/post">
              Post a property
            </Link>
          </div>
        ) : null}

        {needsAction.length > 0 ? (
          <section className="dashboard__group">
            <h2 className="dashboard__grouptitle">Needs your attention</h2>
            {needsAction.map((l) => (
              <ListingRow key={l.id} listing={l} highlight />
            ))}
          </section>
        ) : null}

        {inReview.length > 0 ? (
          <section className="dashboard__group">
            <h2 className="dashboard__grouptitle">In review</h2>
            <p className="dashboard__grouphint">
              We aim to publish within a few hours. If a listing has been here longer than six, our
              team has been alerted automatically.
            </p>
            {inReview.map((l) => (
              <ListingRow key={l.id} listing={l} />
            ))}
          </section>
        ) : null}

        {live.length > 0 ? (
          <section className="dashboard__group">
            <h2 className="dashboard__grouptitle">Live</h2>
            {live.map((l) => (
              <ListingRow key={l.id} listing={l} />
            ))}
          </section>
        ) : null}

        {other.length > 0 ? (
          <section className="dashboard__group">
            <h2 className="dashboard__grouptitle">Expired</h2>
            {other.map((l) => (
              <ListingRow key={l.id} listing={l} />
            ))}
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}

const STATUS_COPY: Record<string, { label: string; tone: string; explain: string }> = {
  DRAFT: {
    label: 'Draft',
    tone: 'muted',
    explain: 'Not submitted yet. Nobody can see this.',
  },
  PENDING_REVIEW: {
    label: 'In review',
    tone: 'pending',
    explain: 'With our review team.',
  },
  LIVE: { label: 'Live', tone: 'ok', explain: 'Visible to everyone searching.' },
  CHANGES_REQUESTED: {
    label: 'Changes requested',
    tone: 'pending',
    explain: 'Our reviewer left a note. Fix it and submit again.',
  },
  REJECTED: {
    label: 'Rejected',
    tone: 'alert',
    explain: 'Not appealable. Read the reason before posting again.',
  },
  EXPIRED: {
    label: 'Expired',
    tone: 'muted',
    explain: 'Taken down after its 90-day run.',
  },
};

function ListingRow({ listing, highlight }: { listing: MyListing; highlight?: boolean }) {
  const status = STATUS_COPY[listing.status] ?? {
    label: listing.status,
    tone: 'muted',
    explain: '',
  };
  const latestNote = listing.events.find((e) => e.action === 'CHANGES_REQUESTED' || e.action === 'REJECTED');

  return (
    <article className={`listingrow ${highlight ? 'listingrow--action' : ''}`}>
      <div className="listingrow__media">
        {listing.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.coverImageUrl} alt="" className="listingrow__thumb" />
        ) : (
          <div className="listingrow__thumb listingrow__thumb--empty" />
        )}
      </div>

      <div className="listingrow__body">
        <p className="listingrow__kind">
          {listing.kind === 'SALE' ? 'For sale' : 'To rent'} · {listing.typeLabel}
        </p>
        <h3 className="listingrow__title">
          <Link href={`/listings/${listing.id}`}>{listing.title}</Link>
        </h3>
        <p className="listingrow__meta">
          {[
            listing.location.areaName,
            listing.location.lgaName,
            listing.location.stateName,
          ]
            .filter(Boolean)
            .join(', ')}
          {' · '}
          {formatNaira(listing.price, { compact: false })}
          {listing.pricePeriod !== 'NONE' ? ` ${formatPricePeriod(listing.pricePeriod as never)}` : ''}
        </p>

        {/*
          The poster's own address is shown here. They wrote it, they may see it;
          nobody else can reach this endpoint.
        */}
        {listing.exactAddress ? (
          <p className="listingrow__address">
            <span>Address</span> {listing.exactAddress}
          </p>
        ) : null}

        <p className="listingrow__status">
          <span className={`pill pill--${status.tone}`}>{status.label}</span> {status.explain}
        </p>

        {latestNote?.note || listing.rejectionReason ? (
          <p className="listingrow__note">
            {latestNote?.note ?? listing.rejectionReason}
          </p>
        ) : null}

        {listing.status === 'LIVE' ? (
          <p className="listingrow__stats">
            {listing.viewCount} views · {listing.revealCount} contact unlocks ·{' '}
            {listing.conversationCount} conversations
          </p>
        ) : null}
      </div>

      <div className="listingrow__actions">
        {listing.status === 'LIVE' ? (
          <Link className="btn btn--ghost" href={`/listings/${listing.id}`}>
            View
          </Link>
        ) : null}
        {listing.status === 'DRAFT' || listing.status === 'CHANGES_REQUESTED' ? (
          <ResubmitButton listingId={listing.id} />
        ) : null}
      </div>
    </article>
  );
}