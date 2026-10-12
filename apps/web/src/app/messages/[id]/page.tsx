/**
 * One conversation.
 *
 * Server-renders the thread, then a client component owns everything after that:
 * sending, and polling for replies.
 *
 * Polling rather than a WebSocket. The reason to be in this thread is to ask a
 * question and get an answer, and the answer rate on a property marketplace is
 * measured in hours. A socket would hold a connection open on a Nigerian mobile
 * network for hours to deliver a handful of messages, and would need reconnection
 * and backoff logic to be no worse than a poll. The poll only runs while the tab is
 * visible, so an abandoned thread costs nothing.
 */

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getHeaderUser } from '@/lib/header';
import { apiFetch, getSessionUser } from '@/lib/session';
import { MessageThread } from '@/components/message-thread';
import { deliveryState, RECEIPT_LABEL, receiptTitle } from '@/lib/message-receipts';
import { formatNaira, formatPricePeriod } from '@naijaproperty/ui';

export const metadata: Metadata = {
  title: 'Conversation',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export interface ThreadMessage {
  id: string;
  clientMessageId: string;
  senderId: string;
  isMine: boolean;
  body: string;
  createdAt: string;
  editedAt: string | null;
  moderationStatus?: string;
  moderationNote?: string;
  /**
   * Receipts. The API has always returned these, but they were never declared
   * here, so the thread rendered a bare clock time and the sender had no idea
   * whether a message had arrived.
   *
   * Both are null on the recipient's own messages: a receipt on a message you
   * wrote is meaningless and would invite a "seen" tick on the wrong bubble.
   *
   *  - deliveredAt: the recipient's client fetched this message.
   *  - seenAt: the recipient's conversation read marker is at or past it.
   */
  deliveredAt?: string | null;
  seenAt?: string | null;
  attachment: { id: string; kind: string; mime: string; url: string | null } | null;
}

export interface Thread {
  id: string;
  status: string;
  listing: {
    id: string;
    title: string;
    isLive: boolean;
    kind: string;
    price: number;
    pricePeriod: string;
  };
  counterpart: { id: string; displayName: string };
  isInitiator: boolean;
  messages: ThreadMessage[];
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return 'Today';
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/messages/${id}`)}`);

  const [thread, headerUser] = await Promise.all([
    apiFetch<Thread>(`/api/v1/conversations/${id}`),
    getHeaderUser(),
  ]);

  // A conversation that is not the viewer's is indistinguishable from one that
  // does not exist, so a guessed id cannot be used to confirm it is real.
  if (!thread) notFound();

  const closed = thread.status === 'BLOCKED';
  const listingGone = !thread.listing.isLive;

  // Day separators, so a thread that spans a few days does not read as one block.
  const withDays: Array<{ label: string; message: ThreadMessage }> = [];
  let lastDay = '';
  for (const message of thread.messages) {
    const label = dayLabel(message.createdAt);
    if (label !== lastDay) {
      withDays.push({ label, message });
      lastDay = label;
    } else {
      withDays.push({ label: '', message });
    }
  }

  return (
    <>
      <SiteHeader active="messages" user={headerUser} />
      <main id="main" className="container thread">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/messages">Messages</Link>
          <span aria-hidden="true">/</span>
          <span>{thread.counterpart.displayName}</span>
        </nav>

        <div className="thread__grid">
          <section className="thread__main">
            <header className="thread__head">
              <h1 className="thread__title">
                {thread.isInitiator
                  ? `With ${thread.counterpart.displayName}`
                  : `${thread.counterpart.displayName} is asking about your listing`}
              </h1>
              <p className="thread__sub">
                {thread.messages.length === 0
                  ? 'No messages yet.'
                  : `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}.`}
              </p>
            </header>

            {listingGone ? (
              <p className="notice notice--warn" role="status">
                This property is no longer listed. Messages still work, but nobody can find it from
                search any more.
              </p>
            ) : null}

            <ol className="bubble" aria-live="polite" aria-label="Messages">
              {withDays.map(({ label, message }, index) => (
                <li key={message.id} className={message.isMine ? 'is-mine' : 'is-theirs'}>
                  {label ? (
                    <p className="bubble__day" role="separator">
                      {label}
                    </p>
                  ) : null}

                  <div className="bubble__row">
                    {!message.isMine ? (
                      <span className="bubble__who">{thread.counterpart.displayName}</span>
                    ) : null}
                    <div className="bubble__bubble">
                      <p className="bubble__text">{message.body}</p>

                      {/*
                        Only the sender is told their message is still being checked.
                        The API withholds the status from the recipient entirely, so
                        this cannot leak that a fraud attempt was ever made.
                      */}
                      {message.moderationStatus === 'PENDING' ? (
                        <p className="bubble__note">Checked before delivery</p>
                      ) : null}
                      {message.moderationStatus === 'REJECTED' ? (
                        <p className="bubble__note bubble__note--bad">
                          Not delivered. {message.moderationNote ?? 'It did not pass our checks.'}
                        </p>
                      ) : null}

                      <p className="bubble__meta">
                        <time className="bubble__time" dateTime={message.createdAt}>
                          {clockTime(message.createdAt)}
                        </time>

                        {/*
                          Receipts on the sender's own messages only.

                          This is the single most requested thing in any messaging
                          product and the thing a seller on mobile data most needs:
                          "did my message actually go out, or did I just burn my
                          data sending into the void". The API already withheld
                          receipts from the recipient, so nothing here can render a
                          tick on the wrong side.
                        */}
                        {message.isMine && message.moderationStatus !== 'PENDING' ? (
                          <span
                            className={`bubble__receipt bubble__receipt--${deliveryState(message)}`}
                            title={receiptTitle(message)}
                          >
                            {RECEIPT_LABEL[deliveryState(message)]}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <MessageThread
              conversationId={thread.id}
              initialMessages={thread.messages}
              counterpartName={thread.counterpart.displayName}
              disabled={closed}
              disabledReason={closed ? 'This conversation is closed.' : undefined}
            />
          </section>

          <aside className="thread__aside">
            <div className="thread__card">
              <h2 className="thread__cardh">The property</h2>
              <p className="thread__cardtitle">
                <Link href={`/listings/${thread.listing.id}`}>{thread.listing.title}</Link>
              </p>
              <p className="thread__cardmeta">
                {formatNaira(thread.listing.price, { compact: false })}
                {thread.listing.pricePeriod !== 'NONE'
                  ? ` ${formatPricePeriod(thread.listing.pricePeriod as never).toLowerCase()}`
                  : ''}
              </p>
              <Link className="btn btn--ghost btn--tiny" href={`/listings/${thread.listing.id}`}>
                View listing
              </Link>
            </div>

            {/*
              Kept in-page rather than behind a reveal, because this thread only
              exists once the viewer has already made contact. Re-locking it here
              would be theatre.
            */}
            {thread.isInitiator ? (
              <div className="thread__card">
                <h2 className="thread__cardh">Keep it on the platform</h2>
                <p className="thread__cardmeta">
                  Paying an agent fee you did not agree to is the most common way people lose money
                  renting in Nigeria. There is no fee to unlock contact details here, and asking to
                  view a property should never cost you anything.
                </p>
              </div>
            ) : null}
          </aside>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}