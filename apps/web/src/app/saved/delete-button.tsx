'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Deletes a saved search. Confirmation is inline rather than a modal. */
export function DeleteSavedSearch({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/saved-searches/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Could not delete that search.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className="btn btn--ghost" onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }

  return (
    <div className="rowactions">
      <button type="button" className="btn btn--danger" onClick={remove} disabled={busy}>
        {busy ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
        Cancel
      </button>
      {error ? <span className="rowactions__error">{error}</span> : null}
    </div>
  );
}