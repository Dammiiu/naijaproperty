/**
 * Audit table.
 *
 * Client component only because the metadata column can hold arbitrary JSON, and
 * rendering an arbitrary object safely needs a real serialiser rather than
 * string concatenation. Nothing here is interactive beyond expand/collapse.
 */

'use client';

import { Fragment, useState } from 'react';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorRole: string | null;
  metadata: unknown;
  createdAt: string;
  actor: { displayName: string; email: string } | null;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (rows.length === 0) {
    return <p className="panel__body">Nothing has been recorded yet.</p>;
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Entity</th>
          <th scope="col">Metadata</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const hasMeta =
            r.metadata && typeof r.metadata === 'object' && Object.keys(r.metadata).length > 0;
          const open = expanded.has(r.id);

          return (
            <Fragment key={r.id}>
              <tr>
                <td className="is-numeric">{formatTimestamp(r.createdAt)}</td>
                <td>
                  {r.actor?.displayName ?? 'system'}
                  <span className="cell__sub">{r.actorRole ?? '-'}</span>
                </td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td>
                  {r.entityType}
                  {r.entityId ? <span className="cell__sub">{r.entityId}</span> : null}
                </td>
                <td>
                  {hasMeta ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny"
                      onClick={() => toggle(r.id)}
                      aria-expanded={open}
                    >
                      {open ? 'Hide' : 'Show'}
                    </button>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
              </tr>
              {hasMeta && open ? (
                <tr>
                  <td colSpan={5}>
                    <pre className="metadata">{safeJson(r.metadata)}</pre>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** ISO to a readable local stamp, without pulling in a date library. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Metadata is attacker-influenced (it embeds user-supplied strings), so it is
 *  stringified, never injected as HTML. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}