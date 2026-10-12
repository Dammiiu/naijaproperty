import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-chrome';
import { getAdminSession } from '@/lib/admin';

export const metadata: Metadata = {
  title: 'Admin console',
  robots: { index: false, follow: false },
};

const TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/review', label: 'Review queue' },
  { href: '/admin/areas', label: 'Areas' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/agencies', label: 'Agencies' },
  { href: '/admin/plans', label: 'Plans & monetisation' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/audit', label: 'Audit trail' },
];

/**
 * Admin shell.
 *
 * Redirects rather than rendering an error, because "you are not an admin" on a
 * page that exists is itself information. A moderator with a narrow role still
 * sees the whole tab list, hiding tabs they cannot use is worse than showing
 * them a clear refusal, because it makes the console feel broken.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) redirect('/login?next=/admin');

  return (
    <div className="admin">
      <header className="admin__bar">
        <div className="container admin__bar-inner">
          <Link href="/" className="brand" aria-label="Naijaproperty home">
            <span className="brand__mark" aria-hidden="true" />
            <span className="brand__name">Naijaproperty</span>
            <span className="admin__badge">Console</span>
          </Link>
          <p className="admin__who">
            Signed in as <strong>{session.displayName}</strong> · {session.role}
          </p>
        </div>
      </header>

      <div className="container admin__body">
        <nav className="admin__nav" aria-label="Console sections">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className="admin__navlink">
              {t.label}
            </Link>
          ))}
        </nav>

        <main id="main" className="admin__main">
          {children}
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}