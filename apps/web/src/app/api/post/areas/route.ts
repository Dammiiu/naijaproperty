/**
 * Areas within an LGA, for the post form's third dropdown.
 *
 * Public and unauthenticated: it is reference data, and the listing form is
 * already behind a session cookie. Proxied rather than called directly so the
 * browser never needs to know the API's address.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

export async function GET(request: Request) {
  const lgaId = new URL(request.url).searchParams.get('lgaId');
  if (!lgaId || !/^[a-z0-9]{20,30}$/i.test(lgaId)) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'An LGA is required' } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/locations/areas?lgaId=${lgaId}`, {
      headers: { accept: 'application/json' },
      // Reference data, but per-LGA and cheap; a short cache keeps backtracking
      // through the form instant.
      next: { revalidate: 300 },
    });
    const payload = await res.json().catch(() => null);
    return NextResponse.json({ areas: Array.isArray(payload) ? payload : [] }, { status: res.status });
  } catch {
    return NextResponse.json({ areas: [] }, { status: 200 });
  }
}