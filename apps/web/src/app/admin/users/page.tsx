import Link from 'next/link';
import { adminFetch, getAdminSession } from '@/lib/admin';
import { UserActions } from './user-actions';

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  verificationTier: string;
  phoneVerified: boolean;
  scopeStates: string[];
  memberSince: string;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  failedLoginCount: number;
  listingCount: number;
  revealCount: number;
  agencyName: string | null;
  agencyLicenceVerified: boolean;
  licenceNo: string | null;
}

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ q?: string; status?: string }>;

export default async function AdminUsersPage({ searchParams }: { searchParams: SearchParams }) {
  const { q, status } = await searchParams;
  const session = await getAdminSession();

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);

  const data = await adminFetch<{ users: UserRow[] }>(
    `/users${params.toString() ? `?${params.toString()}` : ''}`,
  );

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Users unavailable</h1>
        <p className="panel__body">Could not load the user directory.</p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h1 className="panel__title">Users</h1>
        <p className="panel__body">
          {data.users.length} account{data.users.length === 1 ? '' : 's'}.
        </p>

        <form className="adminsearch" action="/admin/users" method="get">
          <label className="visually-hidden" htmlFor="user-search">
            Search by name or email
          </label>
          <input
            id="user-search"
            name="q"
            type="search"
            className="field__input"
            placeholder="Name or email"
            defaultValue={q ?? ''}
          />
          <select name="status" className="field__input" defaultValue={status ?? ''} aria-label="Status">
            <option value="">Any status</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
          <button type="submit" className="btn btn--primary">
            Search
          </button>
          {q || status ? (
            <Link className="btn btn--ghost" href="/admin/users">
              Clear
            </Link>
          ) : null}
        </form>
      </section>

      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Verification</th>
              <th scope="col">Listings</th>
              <th scope="col">Reveals</th>
              <th scope="col">Joined</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.users.length === 0 ? (
              <tr>
                <td colSpan={9} className="table__empty">
                  No accounts match that search.
                </td>
              </tr>
            ) : (
              data.users.map((u) => (
                <tr key={u.id}>
                  <th scope="row">
                    {u.displayName}
                    {u.agencyName ? (
                      <span className="cell__sub">
                        {u.agencyName}
                        {u.agencyLicenceVerified ? ' · licence verified' : ''}
                      </span>
                    ) : null}
                  </th>
                  <td>{u.email}</td>
                  <td>
                    {u.role}
                    {u.scopeStates.length > 0 ? (
                      <span className="cell__sub">Scoped to {u.scopeStates.join(', ')}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className={u.phoneVerified ? 'pill pill--ok' : 'pill pill--muted'}>
                      {u.verificationTier.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                  <td className="is-numeric">{u.listingCount}</td>
                  <td className="is-numeric">{u.revealCount}</td>
                  <td>{new Date(u.memberSince).toISOString().slice(0, 10)}</td>
                  <td>
                    {u.status === 'ACTIVE' ? (
                      <span className="pill pill--ok">Active</span>
                    ) : (
                      <span className="pill pill--alert">{u.status}</span>
                    )}
                    {u.lockedUntil ? (
                      <span className="cell__sub">
                        locked until {new Date(u.lockedUntil).toISOString().slice(0, 16).replace('T', ' ')}
                      </span>
                    ) : null}
                    {u.failedLoginCount > 0 ? (
                      <span className="cell__sub">{u.failedLoginCount} failed sign-ins</span>
                    ) : null}
                  </td>
                  <td>
                    <UserActions
                      user={{
                        id: u.id,
                        displayName: u.displayName,
                        email: u.email,
                        role: u.role,
                        status: u.status,
                        verificationTier: u.verificationTier,
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