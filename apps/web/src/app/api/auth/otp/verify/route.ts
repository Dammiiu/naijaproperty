/**
 * BFF for confirming a one-time code.
 *
 * On success this is what mints the session, so it does the same cookie work as
 * the sign-in route: the API's refresh cookie is scoped to the API origin, and
 * without re-issuing it here the person would verify their number and still be
 * signed out.
 *
 * An unknown phone number is created on first successful verify, which is what
 * makes "sign up with a code" a single step instead of asking for a password
 * first.
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
    const res = await fetch(`${API_URL}/api/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      return NextResponse.json(
        payload ?? { error: { code: 'UNKNOWN', message: 'That code did not work' } },
        { status: res.status },
      );
    }

    const refreshToken = extractRefresh(res.headers.get('set-cookie') ?? '');
    if (!refreshToken) {
      return NextResponse.json(
        { error: { code: 'NO_SESSION', message: 'Verification did not return a session' } },
        { status: 502 },
      );
    }

    const { accessToken: _a, refreshToken: _r, ...safe } = payload ?? {};

    const response = NextResponse.json(safe, { status: res.status });
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