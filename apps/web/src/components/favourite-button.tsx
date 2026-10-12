'use client';

/**
 * Shortlist toggle for a single listing.
 *
 * A real button, not an icon-only div, and it sits outside the card's main link.
 * Nesting an interactive control inside an anchor is invalid and browsers
 * disagree about what a click means, which produces the classic bug where
 * saving a property navigates away instead.
 *
 * Optimistic: the heart fills immediately and rolls back on failure. A round trip
 * on a Nigerian mobile connection is long enough that waiting makes the control
 * feel broken.
 */

import { useState } from 'react';

export function FavouriteButton({
  listingId,
  initialSaved,
  signedIn,
  compact,
}: {
  listingId: string;
  initialSaved: boolean;
  signedIn: boolean;
  compact?: boolean;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  if (!signedIn) {
    return (
      <a
        className={`fave ${compact ? 'fave--compact' : ''}`}
        href={`/login?next=${encodeURIComponent(`/listings/${listingId}`)}`}
        title="Sign in to save this property"
        aria-label="Sign in to save this property"
      >
        <Heart filled={false} />
      </a>
    );
  }

  async function toggle(e: React.MouseEvent) {
    // The whole card is wrapped in a link; never let this become navigation.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;

    const previous = saved;
    setSaved(!previous);
    setBusy(true);

    try {
      const res = await fetch('/api/favourites/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId }),
      });
      if (!res.ok) throw new Error('failed');
      const body = (await res.json()) as { saved?: boolean };
      if (typeof body.saved === 'boolean') setSaved(body.saved);
    } catch {
      // Roll back so the heart never disagrees with the server.
      setSaved(previous);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`fave ${compact ? 'fave--compact' : ''} ${saved ? 'is-saved' : ''}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={saved}
      title={saved ? 'Remove from saved properties' : 'Save this property'}
      aria-label={saved ? 'Remove from saved properties' : 'Save this property'}
    >
      <Heart filled={saved} />
    </button>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.8 4.2 4.2 0 0 1 19.5 10.5c0 5.3-7.5 10-7.5 10Z"
      />
    </svg>
  );
}