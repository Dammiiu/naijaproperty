/**
 * Admin session helper.
 *
 * Separate from the public session module because the access rule is different:
 * being signed in is not enough, the account must hold a staff role. A signed-in
 * renter hitting /admin gets the same not-found treatment as a stranger, rather
 * than a page that confirms the console exists.
 */

import { apiFetch, getSessionUser } from './session';

const STAFF_ROLES = new Set(['MODERATOR', 'ADMIN', 'SUPERADMIN']);

export interface AdminSession {
  id: string;
  email: string;
  displayName: string;
  role: string;
  /** True when the account may change roles and platform settings. */
  canManage: boolean;
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const user = await getSessionUser();
  if (!user || !STAFF_ROLES.has(user.role)) return null;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    // Only ADMIN and SUPERADMIN may change roles, verify licences or edit
    // settings. A MODERATOR reviews listings and nothing else.
    canManage: user.role === 'ADMIN' || user.role === 'SUPERADMIN',
  };
}

/** Authenticated fetch against the admin API. Returns null on any failure. */
export function adminFetch<T>(path: string): Promise<T | null> {
  return apiFetch<T>(`/api/v1/admin${path}`);
}