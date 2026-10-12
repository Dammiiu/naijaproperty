import Link from 'next/link';
import { adminFetch, getAdminSession } from '@/lib/admin';
import { LicenceActions } from './licence-actions';

interface AgencyRow {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  userStatus: string;
  phoneVerified: boolean;
  agencyName: string | null;
  licenceNo: string | null;
  licenceBody: string | null;
  licenceVerified: boolean;
  yearsActive: number | null;
  officeStates: string[];
  listingCount: number;
}

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ filter?: string }>;

export default async function AdminAgenciesPage({ searchParams }: { searchParams: SearchParams }) {
  const { filter } = await searchParams;
  const session = await getAdminSession();
  const data = await adminFetch<{ agencies: AgencyRow[] }>(
    `/agencies${filter ? `?filter=${filter}` : ''}`,
  );

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Agencies unavailable</h1>
        <p className="panel__body">Could not load the agency list.</p>
      </section>
    );
  }

  const unverified = data.agencies.filter((a) => !a.licenceVerified);

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Agencies &amp; licences</h1>
        <p className="panel__body">
          {unverified.length} awaiting review. Verifying a licence is what makes &ldquo;verified
          agent&rdquo; a checkable claim rather than a badge anyone can select.
        </p>

        <nav className="tabs" aria-label="Agency filter">
          <Link href="/admin/agencies" aria-current={!filter ? 'page' : undefined}>
            All ({data.agencies.length})
          </Link>
          <Link
            href="/admin/agencies?filter=unverified"
            aria-current={filter === 'unverified' ? 'page' : undefined}
          >
            Awaiting review ({unverified.length})
          </Link>
          <Link
            href="/admin/agencies?filter=verified"
            aria-current={filter === 'verified' ? 'page' : undefined}
          >
            Verified ({data.agencies.length - unverified.length})
          </Link>
        </nav>
      </section>

      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Agency</th>
              <th scope="col">Licence</th>
              <th scope="col">Body</th>
              <th scope="col">Years</th>
              <th scope="col">Offices</th>
              <th scope="col">Listings</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.agencies.length === 0 ? (
              <tr>
                <td colSpan={9} className="table__empty">
                  No agent profiles yet.
                </td>
              </tr>
            ) : (
              data.agencies.map((a) => (
                <tr key={a.id}>
                  <th scope="row">
                    {a.displayName}
                    <span className="cell__sub">
                      {a.email} · {a.phoneVerified ? 'phone verified' : 'phone not verified'}
                      {a.userStatus !== 'ACTIVE' ? ` · ${a.userStatus}` : ''}
                    </span>
                  </th>
                  <td>{a.agencyName ?? '-'}</td>
                  <td>{a.licenceNo ?? '-'}</td>
                  <td>{a.licenceBody ?? '-'}</td>
                  <td className="is-numeric">{a.yearsActive ?? '-'}</td>
                  <td>{a.officeStates.length ? a.officeStates.join(', ') : '-'}</td>
                  <td className="is-numeric">{a.listingCount}</td>
                  <td>
                    {a.licenceVerified ? (
                      <span className="pill pill--ok">Verified</span>
                    ) : (
                      <span className="pill pill--pending">Pending</span>
                    )}
                  </td>
                  <td>
                    <LicenceActions
                      agency={{
                        id: a.id,
                        agencyName: a.agencyName,
                        licenceNo: a.licenceNo,
                        licenceVerified: a.licenceVerified,
                      }}
                      canManage={session?.canManage ?? false}
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