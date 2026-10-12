import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

/**
 * BFF for listing reviews.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const searchParams = new URLSearchParams();
    const url = new URL(`/api/v1/listings/${encodeURIComponent(id)}/reviews`, API_URL);
    url.search = searchParams.toString();

    const res = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json({ items: [], nextCursor: null, totalCount: 0 }, { status: 200 });
      }
      return NextResponse.json(
        { error: { code: 'UPSTREAM_ERROR', message: 'Could not load reviews' } },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Reviews unavailable' } },
      { status: 503 },
    );
  }
}