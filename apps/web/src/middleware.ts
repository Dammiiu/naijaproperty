/**
 * Session middleware.
 *
 * Exists because of one specific problem: the API *rotates* the refresh token on
 * every refresh, invalidating the previous one. A server component that calls the
 * refresh endpoint therefore cannot persist the replacement token, it has no way
 * to write a cookie from a component, and the very next render would present the
 * now-invalid token and lose the session.
 *
 * So the refresh happens here, in middleware, which runs on the Edge and can set
 * cookies on the outgoing response. The result is two cookies:
 *
 *   njp_refresh  long-lived, httpOnly, rotated on every refresh
 *   njp_access   15 minutes, httpOnly, read by server components
 *
 * Server components only ever read `njp_access`. They never call refresh, which
 * is what makes a multi-component page consistent: one refresh per request,
 * before any component runs.
 *
 * This middleware does not gate access. It only maintains the session. Every page
 * still decides for itself what an anonymous visitor may see, so a signed-out
 * request is handled identically to a signed-in one minus the session.
 */

import { NextResponse, type NextRequest } from 'next/server';

const REFRESH_COOKIE = 'njp_refresh';
const ACCESS_COOKIE = 'njp_access';

/**
 * Refresh slightly before expiry so a token cannot lapse between the middleware
 * check and the component that reads it.
 */
const ACCESS_TTL_MS = 13 * 60 * 1000;

/** How close to expiry we treat an access token as still usable. */
const ACCESS_REFRESH_MARGIN_MS = 60 * 1000;

function apiUrl(): string {
  // `??` alone does not fall back when the variable is set to an empty string,
  // which a blank CI secret or a forwarded Dockerfile ARG produces. Trimming
  // first means blank is treated as absent and the local default still applies.
  const candidate =
    process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  const trimmed = candidate?.trim();
  return (trimmed ? trimmed : 'http://localhost:4000').replace(/\/+$/, '');
}

export async function middleware(request: NextRequest) {
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh) return NextResponse.next();

  const access = request.cookies.get(ACCESS_COOKIE)?.value;

  // Still fresh: do not spend a refresh round trip. This is the common path and
  // it must stay cheap, because it runs on every navigation.
  if (access && notExpiring(access, ACCESS_REFRESH_MARGIN_MS)) {
    return NextResponse.next();
  }

  try {
    const res = await fetch(`${apiUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
    });

    if (!res.ok) {
      // The refresh token is dead or was revoked. Clear both cookies so the user
      // sees the signed-out state immediately instead of a page that silently
      // drops its session details on the next click.
      const cleared = NextResponse.next();
      clearSession(cleared, request);
      return cleared;
    }

    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) return NextResponse.next();

    const response = NextResponse.next();

    // The API returns the rotated refresh token as its own cookie. That cookie is
    // scoped to the API origin and path, so it never reaches this origin, the
    // rotated value must be read out of the header and re-issued here, or the
    // next refresh would present a token that has already been invalidated.
    const rotated = extractRefresh(res.headers.get('set-cookie') ?? '') ?? refresh;

    response.cookies.set(REFRESH_COOKIE, rotated, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 86_400,
    });
    response.cookies.set(ACCESS_COOKIE, body.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(ACCESS_TTL_MS / 1000),
    });

    return response;
  } catch {
    // The API being unreachable must not break browsing. Leave the cookies alone
    // and let the page render its signed-out variant; the next request retries.
    return NextResponse.next();
  }
}

function clearSession(response: NextResponse, request: NextRequest): void {
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
  response.cookies.set(REFRESH_COOKIE, '', opts);
  response.cookies.set(ACCESS_COOKIE, '', opts);
  void request;
}

/**
 * Reads the `exp` claim without verifying the signature.
 *
 * Safe here specifically because this is only a caching decision: a forged token
 * with a future `exp` would let a request skip the refresh, but the resulting
 * request to the API would still fail signature verification and return 401. The
 * middleware never authorises anything on the basis of this value.
 */
function notExpiring(token: string, marginMs: number): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    // atob rather than Buffer: this file runs on the Edge runtime, where Buffer
    // is not guaranteed to exist. base64url needs its two alphabet swaps undone
    // before atob will accept it.
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof decoded.exp !== 'number') return false;
    return decoded.exp * 1000 - marginMs > Date.now();
  } catch {
    return false;
  }
}

/** Pulls njp_refresh out of a possibly multi-cookie Set-Cookie header. */
function extractRefresh(setCookie: string): string | null {
  for (const part of setCookie.split(/,\s*(?=[^;,]+?=)/)) {
    const [pair] = part.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}

export const config = {
  /*
   * Runs on every navigation except static assets and the BFF auth routes.
   * The auth routes are excluded because they are the code that *writes* the
   * session; running a refresh on top of them would race with the login that is
   * in flight.
   */
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
};