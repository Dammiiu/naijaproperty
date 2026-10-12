/**
 * BFF sign-up.
 *
 * Mirrors the sign-in route deliberately: the API returns the refresh token as a
 * cookie scoped to its own origin, so it has to be lifted out of the header and
 * re-issued here or the session is lost on the first navigation. Two copies of
 * this logic is a smell, but the alternative is a shared helper that both routes
 * import, and the two flows will diverge anyway as Google sign-in lands.
 */

import { NextResponse } from 'next/server';
import { API_URL, IS_PROD } from '@/lib/constants';
import { REFRESH_COOKIE } from '@/lib/session';

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      /*
       * Forwarded untouched.
       *
       * EMAIL_ALREADY_REGISTERED and WEAK_PASSWORD are different problems with
       * different fixes. Flattening them to "registration failed" makes the form
       * look broken and leaves the person guessing.
       */
      return NextResponse.json(
        payload ?? { error: { code: 'UNKNOWN', message: 'Could not create the account' } },
        { status: res.status },
      );
    }

    const refreshToken = extractRefresh(res.headers.get('set-cookie') ?? '');
    if (!refreshToken) {
      // A registration that "succeeded" but cannot persist a session is worse
      // than a visible failure: the person thinks they have an account and do not.
      return NextResponse.json(
        { error: { code: 'NO_SESSION', message: 'Sign-up did not return a session' } },
        { status: 502 },
      );
    }

    const { accessToken: _a, refreshToken: _r, ...safe } = (payload ?? {});

    const response = NextResponse.json(safe, { status: 201 });
    response.cookies.set(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TTL_DAYS * 86_400,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the service' } },
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