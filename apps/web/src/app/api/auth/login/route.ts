/**
 * BFF sign-in.
 *
 * Exchanges credentials for a refresh token and stores it in an httpOnly cookie
 * on this origin. The token never reaches browser JavaScript, which is what
 * keeps XSS from being able to exfiltrate a long-lived session.
 */

import { NextResponse } from 'next/server';
import { API_URL, IS_PROD } from '@/lib/constants';
import { REFRESH_COOKIE } from '@/lib/session';

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  if (!body.email || !body.password) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Email and password are both required',
          fields: {
            ...(body.email ? {} : { email: 'Required' }),
            ...(body.password ? {} : { password: 'Required' }),
          },
        },
      },
      { status: 422 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password }),
      cache: 'no-store',
    });

    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      // Forward the API's error shape untouched. In particular the
      // ACCOUNT_LOCKED / INVALID_CREDENTIALS distinction is meaningful to the
      // person signing in, and flattening it to "failed" helps nobody.
      return NextResponse.json(payload ?? { error: { code: 'UNKNOWN', message: 'Sign-in failed' } }, {
        status: res.status,
      });
    }

    // The API returns the refresh token as a cookie scoped to its own origin.
    // Re-issue it on this origin, path-scoped to the whole app so that server
    // components on any route can read it.
    const setCookie = res.headers.get('set-cookie') ?? '';
    const refreshToken = extractRefresh(setCookie);

    if (!refreshToken) {
      // Without a refresh token the session cannot be persisted, so a login that
      // "succeeds" would silently not work. Fail loudly instead.
      return NextResponse.json(
        { error: { code: 'NO_SESSION', message: 'Sign-in did not return a session' } },
        { status: 502 },
      );
    }

    // Strip the tokens. The API's payload is
    // { user: UserProfile, accessToken, refreshToken, expiresInSeconds } and the
    // refresh token has already been moved into a cookie, so what remains is
    // returned as-is rather than re-wrapped, re-wrapping would nest the profile
    // under a second `user` key and every caller would have to know that.
    const { accessToken: _a, refreshToken: _r, ...safe } = (payload ?? {}) as Record<
      string,
      unknown
    >;

    const response = NextResponse.json(safe);
    response.cookies.set(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TTL_DAYS * 86_400,
    });
    // No access cookie is set here. Middleware mints one on the first
    // navigation after sign-in, which keeps the login route free of any
    // assumption about token lifetime.
    return response;
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the sign-in service' } },
      { status: 502 },
    );
  }
}

/** Pulls njp_refresh=... out of a Set-Cookie header, ignoring attributes. */
function extractRefresh(setCookie: string): string | null {
  for (const part of setCookie.split(/,\s*(?=[^;]+?=)/)) {
    const [pair] = part.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === 'njp_refresh') {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}