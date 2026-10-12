import Link from 'next/link';
import { adminFetch } from '@/lib/admin';
import { AreaToggle } from './area-toggle';

interface Area {
  id: string;
  name: string;
  stateCode: string;
  stateName: string;
  lgaName: string;
  isActive: boolean;
  proposalCount: number;
  listingCount: number;
  aliasCount: number;
}

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ filter?: string }>;

export default async function AdminAreasPage({ searchParams }: { searchParams: SearchParams }) {
  const { filter } = await searchParams;
  const active = filter ?? '';

  const data = await adminFetch<{ areas: Area[] }>(`/areas${active ? `?filter=${active}` : ''}`);

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Areas unavailable</h1>
        <p className="panel__body">Could not load the area list.</p>
      </section>
    );
  }

  // Areas a poster proposed and nobody has activated are the queue. Surfacing
  // them above active areas is the whole point of this page.
  const pending = data.areas.filter((a) => !a.isActive);
  const live = data.areas.filter((a) => a.isActive);
  const shown = active === 'inactive' ? pending : active === 'active' ? live : data.areas;

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Areas</h1>
        <p className="panel__body">
          {pending.length} awaiting activation · {live.length} active.
        </p>

        <nav className="tabs" aria-label="Area filter">
          <Link href="/admin/areas" aria-current={!active ? 'page' : undefined}>
            All
          </Link>
          <Link href="/admin/areas?filter=inactive" aria-current={active === 'inactive' ? 'page' : undefined}>
            Awaiting activation ({pending.length})
          </Link>
          <Link href="/admin/areas?filter=active" aria-current={active === 'active' ? 'page' : undefined}>
            Active ({live.length})
          </Link>
        </nav>
      </section>

      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Area</th>
              <th scope="col">LGA</th>
              <th scope="col">State</th>
              <th scope="col">Proposals</th>
              <th scope="col">Listings</th>
              <th scope="col">Aliases</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={8} className="table__empty">
                  No areas match this filter.
                </td>
              </tr>
            ) : (
              shown.map((a) => (
                <tr key={a.id}>
                  <th scope="row">{a.name}</th>
                  <td>{a.lgaName}</td>
                  <td>{a.stateName}</td>
                  <td className="is-numeric">{a.proposalCount}</td>
                  <td className="is-numeric">{a.listingCount}</td>
                  <td className="is-numeric">{a.aliasCount}</td>
                  <td>
                    <span className={a.isActive ? 'pill pill--ok' : 'pill pill--pending'}>
                      {a.isActive ? 'Active' : 'Pending'}
                    </span>
                  </td>
                  <td>
                    <AreaToggle
                      areaId={a.id}
                      name={a.name}
                      isActive={a.isActive}
                      proposalCount={a.proposalCount}
                      listingCount={a.listingCount}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}