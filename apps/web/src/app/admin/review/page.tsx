import Link from 'next/link';
import { adminFetch } from '@/lib/admin';
import { formatNaira, formatPricePeriod } from '@naijaproperty/ui';
import { ReviewDecision } from './review-decision';

interface QueueItem {
  id: string;
  kind: string;
  typeLabel: string;
  title: string;
  description: string;
  price: number;
  pricePeriod: string;
  bedrooms: number | null;
  location: { areaName: string | null; areaIsActive: boolean | null; lgaName: string; stateName: string };
  poster: {
    displayName: string;
    email: string;
    phoneVerified: boolean;
    status: string;
    listingsCount: number;
    memberSince: string;
  };
  media: Array<{ id: string; url: string | null; moderationStatus: string; isCover: boolean }>;
  hasVideo: boolean;
  signals: Array<{ signal: string; severity: string; source: string }>;
  slaMinutesLeft: number | null;
  slaBreached: boolean;
  reviewerId: string | null;
}

export const dynamic = 'force-dynamic';

export default async function AdminReviewPage() {
  const data = await adminFetch<{ items: QueueItem[] }>('/review/items?limit=50');

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Review queue unavailable</h1>
        <p className="panel__body">Could not load the queue. Reload in a moment.</p>
      </section>
    );
  }

  if (data.items.length === 0) {
    return (
      <section className="panel">
        <h1 className="panel__title">Review queue</h1>
        <p className="panel__body">
          Nothing is waiting. The queue is ordered by SLA urgency, so anything that appears here is
          already the most urgent item.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Review queue</h1>
        <p className="panel__body">
          {data.items.length} listing{data.items.length === 1 ? '' : 's'}, most urgent first.
        </p>
      </section>

      <ol className="queue">
        {data.items.map((item) => (
          <li key={item.id}>
            <article className={`queueitem ${item.slaBreached ? 'queueitem--breach' : ''}`}>
              <header className="queueitem__head">
                <div>
                  <p className="queueitem__kind">
                    {item.kind === 'SALE' ? 'For sale' : 'To rent'} · {item.typeLabel}
                  </p>
                  <h2 className="queueitem__title">{item.title}</h2>
                  <p className="queueitem__price">
                    {formatNaira(item.price, { compact: false })}
                    {item.pricePeriod !== 'NONE' ? ` ${formatPricePeriod(item.pricePeriod as never)}` : ''}
                    {item.bedrooms !== null ? ` · ${item.bedrooms} bed` : ''}
                  </p>
                </div>

                <SlaChip minutes={item.slaMinutesLeft} breached={item.slaBreached} />
              </header>

              {item.signals.length > 0 ? (
                <ul className="signals">
                  {item.signals.map((s, i) => (
                    <li key={i} className={`signal signal--${s.severity.toLowerCase()}`}>
                      <strong>{s.signal.replace(/_/g, ' ').toLowerCase()}</strong> · {s.source}
                    </li>
                  ))}
                </ul>
              ) : null}

              {item.media.length > 0 ? (
                <div className="queueitem__media">
                  {item.media.slice(0, 5).map((m) =>
                    m.url ? (
                      <a key={m.id} href={m.url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={m.url} alt="" loading="lazy" />
                      </a>
                    ) : null,
                  )}
                </div>
              ) : (
                <p className="queueitem__nomedia">
                  No photos attached. A listing with no photos should not go live.
                </p>
              )}

              <p className="queueitem__desc">{item.description}</p>

              <dl className="queueitem__facts">
                <div>
                  <dt>Area</dt>
                  <dd>
                    {item.location.areaName ?? 'No area selected'}
                    {item.location.areaIsActive === false ? ' (not yet activated)' : ''} ·{' '}
                    {item.location.lgaName}, {item.location.stateName}
                  </dd>
                </div>
                <div>
                  <dt>Poster</dt>
                  <dd>
                    {item.poster.displayName} · {item.poster.email} ·{' '}
                    {item.poster.phoneVerified ? 'phone verified' : 'phone NOT verified'} ·{' '}
                    {item.poster.listingsCount} listing
                    {item.poster.listingsCount === 1 ? '' : 's'}
                    {item.poster.status !== 'ACTIVE' ? ` · ${item.poster.status}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Video</dt>
                  <dd>{item.hasVideo ? 'Walkthrough attached' : 'None'}</dd>
                </div>
              </dl>

              <p className="queueitem__actions">
                <Link className="btn btn--ghost" href={`/listings/${item.id}`} target="_blank">
                  Open as the public sees it
                </Link>
              </p>

              <ReviewDecision listingId={item.id} />
            </article>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * SLA chip.
 *
 * Turns amber under the 4-hour warning and red past the 6-hour escalation, which
 * matches the warn/escalate thresholds in the SLA policy rather than being
 * invented here, the colour and the database have to agree or the colour lies.
 */
function SlaChip({ minutes, breached }: { minutes: number | null; breached: boolean }) {
  if (minutes === null) return <span className="sla sla--none">No SLA set</span>;

  const tone = breached ? 'sla--breach' : minutes < 60 ? 'sla--urgent' : minutes < 240 ? 'sla--warn' : 'sla--ok';

  return (
    <span className={`sla ${tone}`}>
      {breached
        ? `Breached ${formatWait(-minutes)} ago`
        : `${formatWait(minutes)} left`}
    </span>
  );
}

function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}