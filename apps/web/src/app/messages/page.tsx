/**
 * Conversation inbox.
 *
 * Auth-gated, because a message thread is the most private thing on the site: it
 * contains what someone was looking for and what they offered. Anonymous
 * visitors are redirected rather than shown an empty state, since an empty inbox
 * reads as "you have no messages" and they have no account to have messages on.
 *
 * Server-rendered. The inbox is a list of links, it is reached from a click, and
 * there is nothing here that needs client JavaScript to be correct.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { apiFetch, getSessionUser } from '@/lib/session';
import { formatNaira, formatPricePeriod } from '@naijaproperty/ui';

export const metadata: Metadata = {
  title: 'Messages',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface Conversation {
  id: string;
  listingId: string;
  listingTitle: string;
  listingKind: string;
  listingPrice: number;
  listingPricePeriod: string;
  listingIsLive: boolean;
  listingLocation: string;
  listingCoverUrl: string | null;
  counterpartName: string;
  status: string;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  messageCount: number;
  unread: number;
  isInitiator: boolean;
  updatedWithinAnHour: boolean;
}

/** "4m", "3h", "2d". Compact enough for a list column. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

export default async function MessagesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/messages');

  const [data, headerUser] = await Promise.all([
    apiFetch<{ items: Conversation[] }>('/api/v1/conversations'),
    getHeaderUser(),
  ]);

  const items = data?.items ?? [];
  const unreadTotal = items.reduce((n, c) => n + c.unread, 0);

  return (
    <>
      <SiteHeader active="messages" user={headerUser} />
      <main id="main" className="container dashboard">
        <header className="dashboard__head">
          <div>
            <h1 className="dashboard__title">Messages</h1>
            <p className="dashboard__sub">
              {items.length === 0
                ? 'Conversations with owners and enquirers appear here.'
                : unreadTotal > 0
                  ? `${unreadTotal} unread across ${items.length} conversation${items.length === 1 ? '' : 's'}.`
                  : `${items.length} conversation${items.length === 1 ? '' : 's'}, all read.`}
            </p>
          </div>
          <Link className="btn btn--ghost" href="/favourites">
            Saved properties
          </Link>
        </header>

        {items.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">No conversations yet</h2>
            <p className="empty__body">
              Find a property you like and send the owner a question. Messages you send, and replies
              to properties you have listed, both land here.
            </p>
            <Link className="btn btn--primary" href="/?kind=RENT">
              Browse rentals
            </Link>
          </div>
        ) : (
          <ul className="threadlist">
            {items.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/messages/${c.id}`}
                  className={`threadrow ${c.unread > 0 ? 'is-unread' : ''}`}
                >
                  <span className="threadrow__cover" aria-hidden="true">
                    {c.listingCoverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.listingCoverUrl} alt="" />
                    ) : (
                      <span className="threadrow__noimg" />
                    )}
                  </span>

                  <span className="threadrow__body">
                    <span className="threadrow__top">
                      {/* Who you are talking to. */}
                      <span className="threadrow__who">
                        {c.isInitiator ? `About: ${c.counterpartName}` : `From: ${c.counterpartName}`}
                      </span>
                      <span className="threadrow__when">{relative(c.lastMessageAt)}</span>
                    </span>

                    <span className="threadrow__listing">{c.listingTitle}</span>

                    <span className="threadrow__meta">
                      {formatNaira(c.listingPrice, { compact: true })}
                      {c.listingPricePeriod !== 'NONE'
                        ? ` / ${formatPricePeriod(c.listingPricePeriod as never)}`
                        : ''}
                      {c.listingLocation ? ` · ${c.listingLocation}` : ''}
                    </span>

                    {c.lastMessagePreview ? (
                      <span className="threadrow__preview">{c.lastMessagePreview}</span>
                    ) : null}
                  </span>

                  <span className="threadrow__side">
                    {c.unread > 0 ? (
                      <span className="threadrow__unread">{c.unread}</span>
                    ) : null}
                    {!c.listingIsLive ? (
                      <span className="threadrow__tag">No longer listed</span>
                    ) : null}
                    {c.status === 'BLOCKED' ? (
                      <span className="threadrow__tag">Closed</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}