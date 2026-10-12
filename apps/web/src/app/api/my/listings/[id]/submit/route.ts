/**
 * BFF for the poster's own listing actions.
 *
 * The API scopes these to the authenticated poster, so this proxy cannot be used
 * to act on someone else's listing even if the id is guessed.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in again to continue' } },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/my/listings/${id}/submit`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
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