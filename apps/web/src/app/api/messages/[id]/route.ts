/**
 * BFF for reading a thread and posting into it.
 *
 * `GET` is a proxy for polling; `POST` sends. Both are same-origin so the browser
 * never holds the access token.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to see your messages' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
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

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(`/conversations/${id}`, { method: 'GET' });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(`/conversations/${id}/messages`, {
    method: 'POST',
    body: await request.text(),
  });
}