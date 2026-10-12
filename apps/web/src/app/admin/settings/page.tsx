import { adminFetch, getAdminSession } from '@/lib/admin';
import { SettingsEditor } from './settings-editor';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const [settings, session] = await Promise.all([
    adminFetch<Record<string, unknown>>('/settings'),
    getAdminSession(),
  ]);

  return (
    <section className="panel">
      <h1 className="panel__title">Platform settings</h1>
      <p className="panel__body">
        Stored as a single JSON document, versioned on every write and recorded in the audit trail.
      </p>

      <SettingsEditor initial={settings ?? {}} canManage={session?.canManage ?? false} />
    </section>
  );
}