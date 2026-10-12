/**
 * BFF proxy for contact reveal.
 *
 * Forwards the viewer's session cookie to the API and returns the response
 * verbatim. The API is the only component allowed to decrypt an exact address;
 * this route never sees or handles plaintext PII beyond what the API already
 * decided the viewer is entitled to.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(request: Request) {
  let body: { listingId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  if (!body.listingId) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'listingId is required' } },
      { status: 422 },
    );
  }

  const token = await getAccessToken();
  if (!token) {
    // Checked here as well as by the API so the client gets a 401 it can act on
    // rather than a 403 that reads like a permissions problem.
    const jar = await cookies();
    if (!jar.get('njp_session')) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in to unlock contact details' } },
        { status: 401 },
      );
    }
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/listings/reveal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ listingId: body.listingId }),
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