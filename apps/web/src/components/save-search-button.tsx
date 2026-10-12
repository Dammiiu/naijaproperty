'use client';

/**
 * Saves the current search.
 *
 * Lives next to the result count rather than behind a menu, because the moment
 * someone wants to save a search is the moment they have just tuned it, and
 * asking them to reconstruct the filters later is how saved searches end up
 * empty.
 *
 * Anonymous visitors are routed to sign in rather than shown a disabled button:
 * a dead control on the browse page is worse than an honest prompt, and signing
 * in is required anyway to see contact details.
 */

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const HUMANISE: Record<string, string> = {
  RENT: 'To rent',
  SALE: 'For sale',
  q: '',
  kind: '',
  cursor: '',
  limit: '',
  sort: '',
};

export function SaveSearchButton({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!signedIn) {
    const next = `/saved?${params.toString()}`;
    return (
      <a className="results__save" href={`/login?next=${encodeURIComponent(next)}`}>
        Sign in to save this search
      </a>
    );
  }

  // The query is the current URL's parameters minus pagination and display
  // concerns, which are not part of what the user is asking to watch.
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    if (HUMANISE[key] !== undefined) continue;
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/saved-searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          query: { ...query, kind: (params.get('kind') ?? 'RENT').toUpperCase() },
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string; details?: Array<{ path: string; message: string }> } }
          | null;
        setError(
          body?.error?.details?.[0]?.message ?? body?.error?.message ?? 'Could not save that search.',
        );
        return;
      }

      setDone(true);
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <a className="results__save" href="/saved">
        Saved. View your searches
      </a>
    );
  }

  return (
    <span className="savesearch">
      {!open ? (
        <button type="button" className="results__save results__save--btn" onClick={() => setOpen(true)}>
          Save this search
        </button>
      ) : (
        <span className="savesearch__form">
          <input
            className="savesearch__input"
            placeholder="Name this search (optional)"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name this search"
          />
          <button type="button" className="btn btn--primary btn--tiny" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn--ghost btn--tiny" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </span>
      )}
      {error ? <span className="savesearch__error">{error}</span> : null}
    </span>
  );
}