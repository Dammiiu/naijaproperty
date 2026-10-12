/**
 * Server-side session.
 *
 * Reads the short-lived access token that `middleware.ts` placed in a cookie.
 *
 * It deliberately does *not* call the refresh endpoint. The API rotates the
 * refresh token on every refresh, so a component that refreshed would receive a
 * new token it had no way to store, and the next render would present an
 * invalidated one and lose the session. Middleware owns the refresh; components
 * only read what it decided. That also means a page with three authenticated
 * sections performs zero extra refreshes.
 *
 * Server components need this because the reveal gate, the admin console and a
 * poster's own address must be decided on the server. Deciding them on the
 * client would mean rendering a page that shows a phone number before the check
 * that should have withheld it runs.
 */

import { cookies } from 'next/headers';
import { API_URL } from './constants';

const REFRESH_COOKIE = 'njp_refresh';
const ACCESS_COOKIE = 'njp_access';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  verificationTier: string;
  phoneVerified: boolean;
  createdAt: string;
  twoFactorEnabled: boolean;
}

/**
 * Access token for the current request, or null when signed out.
 *
 * Returns null for every failure mode rather than throwing: an expired session
 * should render the signed-out variant of a page, not a 500.
 */
export async function getAccessToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCESS_COOKIE)?.value ?? null;
}

/** True when a session cookie exists at all, signed in or not. */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return Boolean(jar.get(REFRESH_COOKIE) ?? jar.get(ACCESS_COOKIE));
}

/** Current user, or null when signed out or the session has lapsed. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionUser;
  } catch {
    return null;
  }
}

/**
 * Authenticated fetch for a server component or route handler.
 *
 * Defaults to authenticated. Pass `auth: false` for a public endpoint so an
 * anonymous page does not pay for a token it will not use.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T | null> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');

  if (init.auth !== false) {
    const token = await getAccessToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
  }

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
      cache: init.cache ?? 'no-store',
    });

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Both cookie names, so BFF route handlers read and write exactly what
 * middleware expects. Duplicated here only in name; the values are read from the
 * request, never hard-coded at a call site.
 */
export { ACCESS_COOKIE, REFRESH_COOKIE };