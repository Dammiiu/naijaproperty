import Link from 'next/link';
import { adminFetch } from '@/lib/admin';

interface Overview {
  review: {
    pending: number;
    unassigned: number;
    breached: number;
    medianMinutesToDecision: number | null;
    slaTargetMinutes: number;
    slaEscalateMinutes: number;
  };
  inventory: { live: number; liveRent: number; liveSale: number };
  activity: { newListings24h: number; newUsers24h: number; reveals24h: number; conversations: number };
  attention: { inactiveAreaProposals: number; pendingAgencies: number; suspendedUsers: number };
}

export default async function AdminOverviewPage() {
  const data = await adminFetch<Overview>('/overview');

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Overview unavailable</h1>
        <p className="panel__body">
          The console could not load its metrics. The API may be restarting, so reload in a moment.
        </p>
      </section>
    );
  }

  const { review, inventory, activity, attention } = data;

  // The SLA promise is a product claim, so it is shown as a claim with a
  // measurement next to it, not as a neutral counter.
  const withinSla = review.medianMinutesToDecision !== null && review.medianMinutesToDecision <= review.slaTargetMinutes;

  const attentionItems = [
    {
      label: 'Listings breaching SLA',
      value: review.breached,
      href: '/admin/review',
      urgent: review.breached > 0,
    },
    { label: 'Unassigned in queue', value: review.unassigned, href: '/admin/review', urgent: false },
    {
      label: 'Areas awaiting activation',
      value: attention.inactiveAreaProposals,
      href: '/admin/areas',
      urgent: attention.inactiveAreaProposals > 0,
    },
    {
      label: 'Licences awaiting review',
      value: attention.pendingAgencies,
      href: '/admin/agencies',
      urgent: attention.pendingAgencies > 0,
    },
    {
      label: 'Suspended accounts',
      value: attention.suspendedUsers,
      href: '/admin/users?status=SUSPENDED',
      urgent: false,
    },
  ];

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Overview</h1>

        <div className="statgrid">
          <div className={`stat ${review.breached > 0 ? 'stat--alert' : ''}`}>
            <p className="stat__value">{review.pending}</p>
            <p className="stat__label">Listings awaiting review</p>
          </div>

          <div className={`stat ${withinSla ? '' : 'stat--warn'}`}>
            <p className="stat__value">
              {review.medianMinutesToDecision === null
                ? '-'
                : formatMinutes(review.medianMinutesToDecision)}
            </p>
            <p className="stat__label">
              Median time to decision (target {formatMinutes(review.slaTargetMinutes)})
            </p>
          </div>

          <div className="stat">
            <p className="stat__value">{inventory.live}</p>
            <p className="stat__label">Live listings</p>
            <p className="stat__sub">
              {inventory.liveRent} rent · {inventory.liveSale} sale
            </p>
          </div>

          <div className="stat">
            <p className="stat__value">{activity.reveals24h}</p>
            <p className="stat__label">Contacts unlocked in 24h</p>
            <p className="stat__sub">Highest-intent action on the platform</p>
          </div>

          <div className="stat">
            <p className="stat__value">{activity.newListings24h}</p>
            <p className="stat__label">New listings in 24h</p>
          </div>

          <div className="stat">
            <p className="stat__value">{activity.newUsers24h}</p>
            <p className="stat__label">New sign-ups in 24h</p>
          </div>

          <div className="stat">
            <p className="stat__value">{activity.conversations}</p>
            <p className="stat__label">Conversations started</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title panel__title--sm">Needs a decision</h2>
        <ul className="attention">
          {attentionItems.map((item) => (
            <li key={item.label} className={item.urgent ? 'attention__item is-urgent' : 'attention__item'}>
              <Link href={item.href}>{item.label}</Link>
              <span className="attention__count">{item.value}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel__title panel__title--sm">How the queue should be worked</h2>
        <ul className="prose-list">
          <li>
            The queue is ordered by SLA urgency, not arrival. The listing closest to breaching is
            always first.
          </li>
          <li>
            Anything submitted after {formatMinutes(review.slaEscalateMinutes)} is an escalation,
            not a backlog item.
          </li>
          <li>
            When a description contains a phone number or an email address, that is the actual scam
            vector in this market. Reject rather than request changes, because a poster asked to
            remove a phone number will simply rephrase it.
          </li>
        </ul>
      </section>
    </>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}