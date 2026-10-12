/**
 * Site chrome.
 *
 * Two states, because they are genuinely different products. A signed-out visitor
 * has nothing to manage, so they get search and one call to action. A signed-in
 * user has listings, saved searches and a session, so they get an account menu
 * and the sign-in affordances are removed rather than dimmed.
 *
 * The header answers three questions in order: what is this, how do I find a
 * place, and what can I do. The nav labels are verbs with an object so each one
 * explains itself, and the two searches are distinguished from the act of posting.
 */

import Link from 'next/link';
import { AccountMenu } from './account-menu';
import { getUnreadCount } from '@/lib/header';

export interface HeaderUser {
  displayName: string;
  role: string;
  isStaff: boolean;
}

/**
 * Site header.
 *
 * `unreadCount` is fetched here rather than passed in by each page. It is server
 * state, the header is already a server component, and threading it through ten
 * call sites means one page eventually forgets and the badge silently disappears
 * from exactly the page a waiting reply would be opened from.
 */
export async function SiteHeader({
  active,
  user,
  unreadCount,
}: {
  active?: 'rent' | 'sale' | 'post' | 'messages';
  user?: HeaderUser | null;
  unreadCount?: number;
}) {
  const signedIn = Boolean(user);
  const unread = unreadCount ?? (signedIn ? await getUnreadCount() : 0);

  return (
    <header className="site-header">
      {/* The trust promise, stated once on every page. This is the single
          biggest difference from the incumbents, so it is not left to a
          marketing page nobody visits. */}
      <div className="site-header__trust">
        <div className="container site-header__trustinner">
          <span>Contact details stay locked until you sign in</span>
          <span aria-hidden="true">·</span>
          <span>Every listing reviewed before it goes live</span>
          <span aria-hidden="true">·</span>
          <span>Owners and agents list directly</span>
        </div>
      </div>

      <div className="container site-header__inner">
        <Link href="/" className="brand" aria-label="Naijaproperty home">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Naijaproperty</span>
        </Link>

        <nav className="site-nav" aria-label="Primary">
          {/* Each label names the action and its object, so the nav explains
              itself without a tooltip. */}
          <Link href="/?kind=RENT" aria-current={active === 'rent' ? 'page' : undefined}>
            <span className="site-nav__label">Rent a home</span>
            <span className="site-nav__hint">Flats, rooms, bunks</span>
          </Link>
          <Link href="/?kind=SALE" aria-current={active === 'sale' ? 'page' : undefined}>
            <span className="site-nav__label">Buy a property</span>
            <span className="site-nav__hint">Homes, flats, land</span>
          </Link>
          <Link href="/post" aria-current={active === 'post' ? 'page' : undefined}>
            <span className="site-nav__label">List a property</span>
            <span className="site-nav__hint">Free, reviewed</span>
          </Link>

          {/*
            Messages in the primary nav, not buried behind the account menu.

            It used to exist only as a URL, which made the whole chat feature
            invisible: a poster who had a conversation had no way back to it except
            by re-finding the listing. Anyone whose enquiry is the whole point of
            the site should be one click from the reply.

            Signed-out visitors are not shown it, because there is nothing to show
            them and an empty inbox is a poor advertisement for signing up.
          */}
          {signedIn ? (
            <Link href="/messages" aria-current={active === 'messages' ? 'page' : undefined}>
              <span className="site-nav__label">Messages</span>
              <span className="site-nav__hint">
                {unread > 0
                  ? `${unread} new ${unread === 1 ? 'reply' : 'replies'}`
                  : 'Chats with owners'}
              </span>
            </Link>
          ) : null}
        </nav>

        <div className="site-header__actions">
          {signedIn ? (
            <AccountMenu displayName={user!.displayName} isStaff={user!.isStaff} />
          ) : (
            <>
              <Link href="/login" className="btn btn--ghost">
                Sign in
              </Link>
              <Link href="/register" className="btn btn--primary">
                Join free
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__grid">
          <div>
            <p className="site-footer__brand">Naijaproperty</p>
            <p className="site-footer__tag">
              Property for rent and sale across Nigeria, listed by the people who own it.
            </p>
          </div>

          <div>
            <h2 className="site-footer__h">Renting</h2>
            <ul className="site-footer__links">
              <li>
                <Link href="/?kind=RENT">Browse all rentals</Link>
              </li>
              <li>
                <Link href="/?kind=RENT&pricePeriod=YEARLY">Yearly rents</Link>
              </li>
              <li>
                <Link href="/?kind=RENT&pricePeriod=MONTHLY">Monthly rents</Link>
              </li>
              <li>
                <Link href="/?kind=RENT&bedroomsMin=2">2 bedrooms and up</Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="site-footer__h">Buying</h2>
            <ul className="site-footer__links">
              <li>
                <Link href="/?kind=SALE">All properties for sale</Link>
              </li>
              <li>
                <Link href="/?kind=SALE&type=LAND">Land for sale</Link>
              </li>
              <li>
                <Link href="/?kind=SALE&hasVerifiedTitle=true">Title checked</Link>
              </li>
              <li>
                <Link href="/?kind=SALE&verifiedOnly=true">Verified owners only</Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="site-footer__h">Account</h2>
            <ul className="site-footer__links">
              <li>
                <Link href="/post">Post a property</Link>
              </li>
              <li>
                <Link href="/dashboard">My listings</Link>
              </li>
              <li>
                <Link href="/saved">Saved searches</Link>
              </li>
              <li>
                <Link href="/favourites">Saved properties</Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="site-footer__legal">
          Prices are indicative and always the owner&apos;s to confirm. Verify title documents
          before you pay anyone. We publish an area and an LGA, never a street address. The exact
          address and phone number are only shown to a signed-in person the owner has unlocked them
          for.
        </p>
      </div>
    </footer>
  );
}