/**
 * BFF for saved searches.
 *
 * Every route here is strictly owner-scoped, and the delete and create verbs
 * enforce that server-side. The client only ever sees its own searches.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to use saved searches' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    });

    // 204 carries no body, and res.json() on it throws.
    if (res.status === 204) return new NextResponse(null, { status: 204 });

    const payload = await res.json().catch(() => null);
    return NextResponse.json(payload, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the service' } },
      { status: 502 },
    );
  }
}

export async function GET() {
  return forward('/api/v1/saved-searches', { method: 'GET' });
}

export async function POST(request: Request) {
  return forward('/api/v1/saved-searches', { method: 'POST', body: await request.text() });
}