'use client';

/**
 * Contact reveal gate.
 *
 * This is the single most important interaction in the product. It is the thing
 * the incumbent sites have no equivalent of: they publish the phone number and
 * the exact address to anyone who loads the page, which is why they are full of
 * scraped listings, agent photos, and land that does not exist.
 *
 * Design decisions worth stating:
 *
 *  - The gate names what is hidden and why. "Sign in to see the phone number"
 *     is honest; a vague lock icon reads as a broken page.
 *  - It never implies the address is withheld out of spite. It says the poster
 *     controls who sees it, which is true.
 *  - Reveal is idempotent server-side (one contact_reveal row per viewer per
 *     listing), so a user who reveals, signs out and comes back keeps access.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StartConversationButton } from './start-conversation-button';

interface Props {
  listingId: string;
  signedIn: boolean;
  isOwner: boolean;
  revealed: boolean;
  exactAddress: string | null;
  ownerPhone: string | null;
  /**
   * Existing thread for this listing, when one exists.
   *
   * The reveal opens a conversation server-side, so this is usually set on the
   * unlocked path. Passing it means the message button continues the same thread
   * rather than opening a second one.
   */
  conversationId?: string | null;
}

export function ContactPanel({
  listingId,
  signedIn,
  isOwner,
  revealed,
  exactAddress,
  ownerPhone,
  conversationId,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(revealed || isOwner);

  if (isOwner) {
    return (
      <section className="contact contact--owner" aria-label="Your listing">
        <h2 className="contact__title">This is your listing</h2>
        <dl className="contact__list">
          <div className="contact__row">
            <dt>Exact address</dt>
            <dd>{exactAddress ?? 'Not provided'}</dd>
          </div>
          <div className="contact__row">
            <dt>Phone shown to viewers</dt>
            <dd>{ownerPhone ?? 'No phone on file'}</dd>
          </div>
        </dl>
        <a className="btn btn--ghost" href="/dashboard">
          Manage this listing
        </a>
      </section>
    );
  }

  if (unlocked) {
    return (
      <section className="contact contact--unlocked" aria-label="Owner contact details">
        <h2 className="contact__title">Contact details</h2>
        <p className="contact__note">
          Please be respectful. Do not send money before viewing the property or verifying the
          title documents.
        </p>
        <dl className="contact__list">
          <div className="contact__row">
            <dt>Exact address</dt>
            <dd>{exactAddress ?? 'The owner has not provided a street address'}</dd>
          </div>
          <div className="contact__row">
            <dt>Phone</dt>
            <dd>
              {ownerPhone ? (
                <a className="contact__phone" href={`tel:${ownerPhone.replace(/\s+/g, '')}`}>
                  {ownerPhone}
                </a>
              ) : (
                'The owner has not published a number, so use the message button below'
              )}
            </dd>
          </div>
        </dl>
        {/*
          Links to this listing's thread, not the generic inbox. Someone who has
          just unlocked a listing has one specific thing to say about it, and
          dropping them on a list of conversations makes them hunt for the right
          one.
        */}
        <StartConversationButton
          listingId={listingId}
          conversationId={conversationId}
          label="Message the owner in-app"
          variant="primary"
          block
          signedIn={signedIn}
        />
        <a className="contact__wha" href={`https://wa.me/?text=${encodeURIComponent(`Hello, I found your listing on Naijaproperty and I'm interested.`)}`}>
          Or message on WhatsApp
        </a>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section className="contact contact--locked" aria-label="Contact details are locked">
        <h2 className="contact__title">Contact details are locked</h2>
        <p className="contact__body">
          Sign in to see the exact address and phone number. We hide them from signed-out visitors
          because it is how scammers harvest live listings and repost them as their own.
        </p>
        <ul className="contact__list-preview" aria-label="What is hidden">
          <li>
            <span className="contact__masked" aria-hidden="true" />
            Exact address
          </li>
          <li>
            <span className="contact__masked" aria-hidden="true" />
            Phone number
          </li>
        </ul>
        <a
          className="btn btn--primary btn--block"
          href={`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`}
        >
          Sign in to view
        </a>
        {/*
            Messaging needs an account too, so the control is present but routes
            through sign-in. Hiding it would imply messaging is for members only,
            which is exactly backwards for the audience we want.
          */}
        <StartConversationButton
          listingId={listingId}
          label="Ask a question instead"
          variant="ghost"
          block
          signedIn={false}
        />
        <p className="contact__alt">
          No account? <a href="/register">Join free</a>. It takes under a minute.
        </p>
      </section>
    );
  }

  return (
    <section className="contact contact--locked" aria-label="Unlock contact details">
      <h2 className="contact__title">Unlock the contact details</h2>
      <p className="contact__body">
        The poster has chosen to share their exact address and number only with people who have
        signed in. Revealing is recorded on your account, so you only do this once.
      </p>

      {error ? (
        <p className="contact__error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch('/api/listings/reveal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ listingId }),
            });

            if (res.status === 401) {
              router.push(`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`);
              return;
            }

            const body = (await res.json()) as { error?: { code?: string; message?: string } };
            if (!res.ok) {
              setError(body.error?.message ?? 'Could not unlock the contact details.');
              return;
            }

            // Re-render on the server so the decrypted address and number come
            // from the API rather than being echoed back from this response.
            setUnlocked(true);
            router.refresh();
          } catch {
            setError('Could not reach the service. Check your connection and try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Unlocking…' : 'Show me the contact details'}
      </button>

      {/*
          A question does not need a reveal.

          Most first contact is a question: is the rent inclusive of water, is the
          compound gated, can I view on Saturday. Making people unlock contact
          details to ask that turns the trust gate into a toll, and teaches people
          that our gate is a barrier rather than a signal. The thread is moderated
          before the owner sees it, so opening one costs the poster nothing.
        */}
      <StartConversationButton
        listingId={listingId}
        conversationId={conversationId}
        label="Ask a question instead"
        variant="ghost"
        block
        signedIn={signedIn}
      />
    </section>
  );
}