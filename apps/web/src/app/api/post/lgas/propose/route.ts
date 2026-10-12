/**
 * BFF for proposing a local government area.
 *
 * Separate from `/api/post/areas` because that one lists areas for a chosen LGA
 * (a GET) and proposes an area under an existing one. Neither covers a poster
 * typing an LGA we do not have yet.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(request: Request) {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to post a property' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/locations/lgas/propose`, {
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