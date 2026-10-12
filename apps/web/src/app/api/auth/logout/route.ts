/**
 * BFF sign-out.
 *
 * Ends the session server-side and clears both cookies. Clearing only the web
 * cookie would leave a live refresh token in the API's own cookie jar, which is
 * the state a shared-device user is actually exposed to.
 */

import { NextResponse } from 'next/server';
import { API_URL, IS_PROD } from '@/lib/constants';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/session';

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

export async function POST(request: Request) {
  const incoming = request.headers.get('cookie') ?? '';
  const refresh = incoming
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))
    ?.slice(REFRESH_COOKIE.length + 1);

  if (refresh) {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: decodeURIComponent(refresh) }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  const opts = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };

  /*
   * Both cookies, not just the refresh token.
   *
   * Clearing only the refresh token leaves a still-valid 13-minute access token
   * behind. Every server component reads `njp_access`, so the header would keep
   * showing the account menu and `/favourites` would keep rendering saved
   * properties after a sign-out. The session looks over to the user until the
   * access token happens to lapse.
   */
  response.cookies.set(REFRESH_COOKIE, '', opts);
  response.cookies.set(ACCESS_COOKIE, '', opts);

  return response;
}