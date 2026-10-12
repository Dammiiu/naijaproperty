/**
 * BFF for creating and submitting a listing.
 *
 * Create and submit are separate API calls because the poster needs a chance to
 * review before the listing enters the moderation queue, where an admin's SLA
 * starts. This route chains them so the client has one request to make and one
 * place to fail.
 *
 * If the listing is created but submission fails, the draft is deliberately left
 * in place and its id is returned. Losing a fully-phrased listing because the
 * final call timed out would be the single most frustrating failure in the whole
 * product, and the poster can retry submission from the dashboard.
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };

  try {
    const createRes = await fetch(`${API_URL}/api/v1/listings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const created = (await createRes.json().catch(() => null)) as Record<string, unknown> | null;

    if (!createRes.ok) {
      // Validation and moderation failures are the client's problem to render,
      // so they are forwarded verbatim with their field paths intact.
      return NextResponse.json(created ?? { error: { code: 'UNKNOWN', message: 'Could not create the listing' } }, {
        status: createRes.status,
      });
    }

    const listingId = created?.id as string | undefined;
    if (!listingId) {
      return NextResponse.json(
        { error: { code: 'NO_ID', message: 'The listing was created but no id was returned' } },
        { status: 502 },
      );
    }

    const submitRes = await fetch(`${API_URL}/api/v1/listings/${listingId}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      cache: 'no-store',
    });

    const submitted = (await submitRes.json().catch(() => null)) as Record<string, unknown> | null;

    if (!submitRes.ok) {
      return NextResponse.json(
        {
          ...submitted,
          error: {
            code: (submitted?.error as { code?: string } | undefined)?.code ?? 'SUBMIT_FAILED',
            message:
              (submitted?.error as { message?: string } | undefined)?.message ??
              'The listing was saved as a draft but could not be sent for review.',
          },
          listingId,
          draft: true,
        },
        { status: submitRes.status },
      );
    }

    return NextResponse.json({ ...submitted, listingId });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the listing service' } },
      { status: 502 },
    );
  }
}