'use client';

/**
 * Start (or continue) a conversation about one listing.
 *
 * Kept separate from the reveal gate because the two answer different questions.
 * Revealing is "I am serious, show me the address". Messaging is "I have a
 * question". A renter who just wants to ask whether the rent includes water
 * should not have to unlock contact details to do it, and forcing that would make
 * the reveal feel like a toll rather than a trust gate.
 *
 * The reveal also opens a thread server-side, so after unlocking, this same
 * control lands the viewer in the existing conversation rather than a second one.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function StartConversationButton({
  listingId,
  conversationId,
  label = 'Ask a question',
  variant = 'ghost',
  block = false,
  signedIn,
}: {
  listingId: string;
  /** Already-open thread, when the reveal has created one. */
  conversationId?: string | null;
  label?: string;
  variant?: 'primary' | 'ghost';
  block?: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`);
      return;
    }

    // Known thread: nothing to create, just navigate.
    if (conversationId) {
      router.push(`/messages/${conversationId}`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId }),
      });

      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`);
        return;
      }

      const body = (await res.json()) as { id?: string; error?: { message?: string } };
      if (!res.ok || !body.id) {
        setError(body.error?.message ?? 'Could not open a conversation.');
        return;
      }

      router.push(`/messages/${body.id}`);
    } catch {
      setError('Could not reach the service. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn btn--${variant} ${block ? 'btn--block' : ''}`}
        onClick={open}
        disabled={busy}
      >
        {busy ? 'Opening…' : label}
      </button>
      {error ? (
        <p className="contact__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}