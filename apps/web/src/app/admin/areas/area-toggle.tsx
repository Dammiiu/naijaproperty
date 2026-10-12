'use client';

/**
 * Area activation toggle.
 *
 * Activating an area is the single highest-leverage action in the console: it
 * makes the area selectable in the post form and in search, and it is how a
 * poster's proposal turns into searchable inventory. So the button states
 * explicitly how many listings are waiting on it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AreaToggle({
  areaId,
  name,
  isActive,
  proposalCount,
  listingCount,
}: {
  areaId: string;
  name: string;
  isActive: boolean;
  proposalCount: number;
  listingCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/areas/${areaId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Could not save that change.');
        return;
      }

      router.refresh();
    } catch {
      setError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="areatoggle">
      <button
        type="button"
        className={isActive ? 'btn btn--ghost' : 'btn btn--primary'}
        onClick={toggle}
        disabled={busy}
        title={
          isActive
            ? `Hide ${name} from the post form and search`
            : `Make ${name} selectable. Currently ${listingCount} listing(s)`
        }
      >
        {busy ? '…' : isActive ? 'Deactivate' : 'Activate'}
      </button>
      {error ? <span className="areatoggle__error">{error}</span> : null}
    </span>
  );
}