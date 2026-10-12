'use client';

/**
 * Review decision controls.
 *
 * One listing card, one decision. Rejecting and requesting changes both require a
 * reason, because "please provide a better photo" is useless to the person who
 * posted the listing six hours ago and is now staring at a blank screen.
 *
 * The confirm step exists because approving is irreversible from the queue view
 * and a mis-click on the wrong card is a real failure mode when a moderator is
 * working through 30 listings an hour.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Action = 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';

const ACTIONS: Array<{
  action: Action;
  label: string;
  hint: string;
  className: string;
}> = [
  { action: 'APPROVED', label: 'Approve', hint: 'Goes live immediately.', className: 'btn--primary' },
  {
    action: 'CHANGES_REQUESTED',
    label: 'Request changes',
    hint: 'Back to the poster with a reason. They can resubmit.',
    className: 'btn--ghost',
  },
  {
    action: 'REJECTED',
    label: 'Reject',
    hint: 'Not appealable. Use this for scams, not for thin listings.',
    className: 'btn--danger',
  },
];

export function ReviewDecision({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: Action) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/review/${listingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          reasonCode: reasonCode || undefined,
          note: note || undefined,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'That decision could not be saved.');
        return;
      }

      setOpen(null);
      router.refresh();
    } catch {
      setError('Could not reach the service. The decision was not saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="decision">
      <div className="decision__actions">
        {ACTIONS.map((a) => (
          <button
            key={a.action}
            type="button"
            className={`btn ${a.className}`}
            title={a.hint}
            onClick={() => {
              setError(null);
              setNote('');
              setReasonCode('');
              // Approve is single-click; anything that costs the poster something
              // needs the reason form first.
              if (a.action === 'APPROVED') {
                void submit(a.action);
              } else {
                setOpen(a.action);
              }
            }}
            disabled={busy}
          >
            {busy && open === null ? 'Saving…' : a.label}
          </button>
        ))}
      </div>

      {open ? (
        <div className="decision__form">
          <label className="field__label" htmlFor={`reason-${listingId}`}>
            Reason code
          </label>
          <select
            id={`reason-${listingId}`}
            className="field__input"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
          >
            <option value="">Not specified</option>
            <option value="CONTACT_IN_BODY">Contact details in the description</option>
            <option value="PHOTOS_UNUSABLE">Photos unusable or unrelated</option>
            <option value="WRONG_LOCATION">Location does not match the description</option>
            <option value="PRICE_MISMATCH">Price does not match the description</option>
            <option value="TITLE_NOT_VERIFIED">Title could not be verified</option>
            <option value="DUPLICATE">Duplicate of another listing</option>
            <option value="SCAM_SUSPECTED">Suspected scam</option>
            <option value="MISSING_INFO">Required information missing</option>
          </select>

          <label className="field__label" htmlFor={`note-${listingId}`}>
            Note to the poster
          </label>
          <textarea
            id={`note-${listingId}`}
            className="field__input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Say what to change. They see this word for word."
          />

          {error ? (
            <p className="contact__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="decision__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => submit(open)}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error && !open ? (
        <p className="contact__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}