'use client';

/**
 * User moderation controls.
 *
 * Every punitive action requires a typed reason. This is not friction for its own
 * sake: the audit log is append-only, so this is the only record of why someone
 * was suspended, and "we had a complaint" three months later is not an answer.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface UserRow {
  id: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  verificationTier: string;
}

export function UserActions({ user, canManage }: { user: UserRow; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'suspend' | 'reinstate' | 'role' | null>(null);
  const [reason, setReason] = useState('');
  const [nextRole, setNextRole] = useState(user.role);

  const suspended = user.status === 'SUSPENDED';

  async function send(action: 'suspend' | 'reinstate' | 'role') {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (action === 'suspend') {
        payload.status = 'SUSPENDED';
        payload.reason = reason;
      } else if (action === 'reinstate') {
        payload.status = 'ACTIVE';
      } else {
        payload.role = nextRole;
        payload.reason = reason;
      }

      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Could not save that change.');
        return;
      }

      setAsking(null);
      setReason('');
      router.refresh();
    } catch {
      setError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return <span className="muted">Moderator, read only</span>;
  }

  return (
    <div className="rowactions">
      {suspended ? (
        <button type="button" className="btn btn--ghost" onClick={() => send('reinstate')} disabled={busy}>
          {busy ? '…' : 'Reinstate'}
        </button>
      ) : (
        <button type="button" className="btn btn--danger" onClick={() => setAsking('suspend')} disabled={busy}>
          Suspend
        </button>
      )}

      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          setNextRole(user.role);
          setAsking('role');
        }}
        disabled={busy}
      >
        Change role
      </button>

      {asking ? (
        <div className="rowactions__form">
          {asking === 'role' ? (
            <select
              className="field__input"
              value={nextRole}
              onChange={(e) => setNextRole(e.target.value as UserRow['role'])}
              aria-label="New role"
            >
              {['USER', 'AGENT', 'MODERATOR', 'ADMIN', 'SUPERADMIN'].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : null}

          <input
            className="field__input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (recorded permanently)"
            aria-label="Reason"
          />

          {error ? <span className="rowactions__error">{error}</span> : null}

          <div className="rowactions__buttons">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || reason.trim().length < 3}
              onClick={() => send(asking)}
            >
              {busy ? '…' : 'Confirm'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}