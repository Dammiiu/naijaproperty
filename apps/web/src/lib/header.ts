/**
 * Session-derived header state.
 *
 * Every page needs to know whether to render the account menu or the sign-in
 * buttons, and doing that lookup per page means one more thing to forget. This
 * centralises it so a new page cannot accidentally render the signed-out header
 * while signed in.
 */

import { getSessionUser, getAccessToken } from './session';
import { API_URL } from './constants';
import type { HeaderUser } from '@/components/site-chrome';

const STAFF_ROLES = new Set(['MODERATOR', 'ADMIN', 'SUPERADMIN']);

/** Returns null when signed out, so the header can fall back cleanly. */
export async function getHeaderUser(): Promise<HeaderUser | null> {
  const user = await getSessionUser();
  if (!user) return null;

  return {
    displayName: user.displayName,
    role: user.role,
    isStaff: STAFF_ROLES.has(user.role),
  };
}

/**
 * Total unread messages across every conversation.
 *
 * Lives here, next to the session lookup, because the header needs it on every
 * page and it is only meaningful when signed in.
 *
 * Returns 0 on any failure rather than throwing. A header is chrome: if the
 * count cannot be read, the header should still render, and an unread badge is
 * not worth failing a page render over. It is also `no-store`, because a stale
 * count that says zero while a reply is waiting is worse than no count.
 */
export async function getUnreadCount(): Promise<number> {
  const token = await getAccessToken();
  if (!token) return 0;

  try {
    const res = await fetch(`${API_URL}/api/v1/conversations`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return 0;

    const body = (await res.json()) as { items?: Array<{ unread?: number }> };
    return (body.items ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0);
  } catch {
    return 0;
  }
}