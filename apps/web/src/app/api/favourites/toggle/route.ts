/**
 * BFF for the shortlist toggle.
 *
 * The path has to be its own segment rather than a single `/api/favourites`
 * route: Next.js will not route POST to `/api/favourites/toggle` from a handler
 * declared at `/api/favourites`, so the browser gets a 404 and the optimistic
 * heart silently rolls back.
 *
 * The toggle is one endpoint that reports the resulting state, so the client can
 * never drift from what the server holds.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(request: Request) {
  const token = await getAccessToken();
  if (!token) {
    // 401 rather than a redirect: this is a client fetch, and a 3xx here would
    // hand the caller an HTML login page it cannot read.
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to save properties' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/favourites/toggle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: await request.text(),
      cache: 'no-store',
    });

    const payload = await res.json().catch(() => null);
    return NextResponse.json(payload, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the service' } },
      { status: 502 },
    );
  }
}