import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

/**
 * BFF for similar listings.
 *
 * The API endpoint is public (no auth required), but we still proxy through
 * the BFF so the browser never sees the API host and the client bundle stays
 * independent of the API URL structure.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const res = await fetch(`${API_URL}/api/v1/listings/${encodeURIComponent(id)}/similar`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 60 }, // Similar listings can be cached briefly
    });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json({ items: [] }, { status: 200 });
      }
      return NextResponse.json(
        { error: { code: 'UPSTREAM_ERROR', message: 'Could not load similar listings' } },
        { status: 502 },
      );
    }

    const data = (await res.json()) as { items: Array<Record<string, unknown>> };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Similar listings unavailable' } },
      { status: 503 },
    );
  }
}