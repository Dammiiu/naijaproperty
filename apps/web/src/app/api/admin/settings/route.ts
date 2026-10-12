import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

/** BFF proxy for platform settings writes. */
export async function POST(request: Request) {
  const token = await getAccessToken();

  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in again to continue' } },
      { status: 401 },
    );
  }

  const body = await request.text();
  // Forwarded as text so a malformed document reaches the API and gets a
  // structured validation error rather than being silently dropped here.
  try {
    JSON.parse(body);
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Body is not valid JSON' } },
      { status: 422 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/admin/settings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
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