'use client';

/**
 * Licence approval.
 *
 * Verifying a licence is the claim the whole "verified agent" badge rests on, so
 * the form records the licence number and issuing body rather than just a boolean.
 * Revoking requires a reason, because revoking pulls the verified badge off
 * listings that are already live and the agent deserves to know why.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Agency {
  id: string;
  agencyName: string | null;
  licenceNo: string | null;
  licenceVerified: boolean;
}

export function LicenceActions({
  agency,
  canManage,
}: {
  agency: Agency;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'verify' | 'revoke' | null>(null);
  const [licenceNo, setLicenceNo] = useState(agency.licenceNo ?? '');
  const [licenceBody, setLicenceBody] = useState('');
  const [reason, setReason] = useState('');

  if (!canManage) {
    return <span className="muted">Requires ADMIN</span>;
  }

  async function send(verify: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/agencies/${agency.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verify,
          licenceNo: verify && licenceNo ? licenceNo : undefined,
          licenceBody: verify && licenceBody ? licenceBody : undefined,
          reason: verify ? undefined : reason,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Could not save that change.');
        return;
      }

      setMode(null);
      setReason('');
      router.refresh();
    } catch {
      setError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rowactions">
      {agency.licenceVerified ? (
        <button type="button" className="btn btn--danger" onClick={() => setMode('revoke')} disabled={busy}>
          Revoke
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={() => setMode('verify')} disabled={busy}>
          Verify licence
        </button>
      )}

      {mode ? (
        <div className="rowactions__form">
          {mode === 'verify' ? (
            <>
              <input
                className="field__input"
                value={licenceNo}
                onChange={(e) => setLicenceNo(e.target.value)}
                placeholder="Licence number"
                aria-label="Licence number"
              />
              <select
                className="field__input"
                value={licenceBody}
                onChange={(e) => setLicenceBody(e.target.value)}
                aria-label="Issuing body"
              >
                <option value="">Issuing body…</option>
                <option value="RERAQ">RERAQ (Lagos)</option>
                <option value="AMAP">AMAP (Abuja)</option>
                <option value="PNGSDT">PNGSDT</option>
                <option value="OTHER">Other</option>
              </select>
            </>
          ) : (
            <input
              className="field__input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (removes the badge from live listings)"
              aria-label="Reason"
            />
          )}

          {error ? <span className="rowactions__error">{error}</span> : null}

          <div className="rowactions__buttons">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || (mode === 'revoke' && reason.trim().length < 3)}
              onClick={() => send(mode === 'verify')}
            >
              {busy ? '…' : 'Confirm'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}