'use client';

/**
 * Platform settings editor.
 *
 * Free-form JSON rather than a fixed form, because the settings shape is still
 * moving and a hardcoded form would need a code change for every new key. The
 * validation that does exist is client-side parse, so an invalid document is
 * caught before it can be stored and break something at read time.
 *
 * Gated behind an ADMIN role in the UI *and* in the API. The UI gate is
 * convenience; the API gate is the one that counts.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SettingsEditor({
  initial,
  canManage,
}: {
  initial: Record<string, unknown>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!canManage) {
    return (
      <p className="panel__body">
        Platform settings can only be changed by an ADMIN or SUPERADMIN.
      </p>
    );
  }

  async function save() {
    setParseError(null);
    setSaveError(null);
    setSaved(false);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setParseError(`Not valid JSON: ${(err as Error).message}`);
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setParseError('Settings must be a JSON object, not an array or a scalar.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setSaveError(body?.error?.message ?? 'Could not save the settings.');
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setSaveError('Could not reach the service.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <label className="visually-hidden" htmlFor="settings-json">
        Platform settings as JSON
      </label>
      <textarea
        id="settings-json"
        className="field__input field__input--code"
        rows={18}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        spellCheck={false}
      />

      {parseError ? (
        <p className="contact__error" role="alert">
          {parseError}
        </p>
      ) : null}
      {saveError ? (
        <p className="contact__error" role="alert">
          {saveError}
        </p>
      ) : null}
      {saved ? <p className="settings__ok">Saved. The change is in the audit trail.</p> : null}

      <div className="decision__actions">
        <button type="button" className="btn btn--primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setText(JSON.stringify(initial, null, 2))}>
          Reset
        </button>
      </div>

      <p className="panel__body">
        Each save creates a new row rather than overwriting, so the previous value remains
        recoverable. Settings are not read on any hot path, so a change here takes effect on the
        next request that consults them.
      </p>
    </div>
  );
}