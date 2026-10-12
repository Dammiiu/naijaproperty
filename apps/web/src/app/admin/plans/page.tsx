import { adminFetch } from '@/lib/admin';
import { formatNaira } from '@naijaproperty/ui';

interface Plan {
  code: string;
  name: string;
  tier: string;
  priceNgn: number;
  billingPeriod: string;
  description: string;
  entitlements: Array<{ feature: string; limit: unknown }>;
}

interface PlansResponse {
  plans: Plan[];
  livePayments: boolean;
  note: string;
  verificationTierCounts: Array<{ tier: string; count: number }>;
}

export const dynamic = 'force-dynamic';

export default async function AdminPlansPage() {
  const data = await adminFetch<PlansResponse>('/plans');

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Plans unavailable</h1>
        <p className="panel__body">Could not load the plan configuration.</p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Plans &amp; monetisation</h1>
        <p className="panel__body">{data.note}</p>

        <p className={data.livePayments ? 'pill pill--alert' : 'pill pill--muted'}>
          Live payments: {data.livePayments ? 'ENABLED' : 'disabled by design'}
        </p>
      </section>

      <section className="panel">
        <div className="plangrid">
          {data.plans.map((p) => (
            <article className="plan" key={p.code}>
              <header className="plan__head">
                <h2 className="plan__name">{p.name}</h2>
                <p className="plan__price">
                  {formatNaira(p.priceNgn, { compact: false })}
                  <span className="plan__period"> /{p.billingPeriod}</span>
                </p>
              </header>

              <p className="plan__tier">{p.tier}</p>
              <p className="plan__desc">{p.description}</p>

              <h3 className="plan__sub">Entitlements</h3>
              <ul className="plan__list">
                {p.entitlements.map((e) => (
                  <li key={e.feature}>
                    <span>{e.feature.replace(/_/g, ' ').toLowerCase()}</span>
                    <span className="is-numeric">
                      {e.limit === null || e.limit === undefined
                        ? 'unlimited'
                        : typeof e.limit === 'object'
                          ? JSON.stringify(e.limit)
                          : String(e.limit)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title panel__title--sm">Accounts by verification tier</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col">Accounts</th>
            </tr>
          </thead>
          <tbody>
            {data.verificationTierCounts.map((c) => (
              <tr key={c.tier}>
                <th scope="row">{c.tier.replace(/_/g, ' ').toLowerCase()}</th>
                <td className="is-numeric">{c.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}