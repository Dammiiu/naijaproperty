import { adminFetch } from '@/lib/admin';
import { AuditTable } from './audit-table';

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

export const dynamic = 'force-dynamic';

export default async function AdminAuditPage() {
  const data = await adminFetch<AuditRow[]>('/audit?limit=100');

  if (!data) {
    return (
      <section className="panel">
        <h1 className="panel__title">Audit trail unavailable</h1>
        <p className="panel__body">Could not load the audit log.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h1 className="panel__title">Audit trail</h1>
      <p className="panel__body">
        Append-only at the database level. A <code>BEFORE UPDATE OR DELETE</code> trigger rejects
        any attempt to edit or remove a row, including by an administrator.
      </p>

      <AuditTable rows={data} />
    </section>
  );
}