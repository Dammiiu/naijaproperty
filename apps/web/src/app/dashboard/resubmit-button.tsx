'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Resubmits a draft or a listing that came back for changes. */
export function ResubmitButton({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="resubmit">
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch(`/api/my/listings/${listingId}/submit`, { method: 'POST' });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as
                | { error?: { message?: string } }
                | null;
              setError(body?.error?.message ?? 'Could not submit that listing.');
              return;
            }
            router.refresh();
          } catch {
            setError('Could not reach the service.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Submitting…' : 'Submit for review'}
      </button>
      {error ? <p className="rowactions__error">{error}</p> : null}
    </div>
  );
}