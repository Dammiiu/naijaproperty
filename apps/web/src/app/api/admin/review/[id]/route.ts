/**
 * BFF proxy for a review decision.
 *
 * Thin on purpose: the decision logic, the audit row and the SLA accounting all
 * live in the API. The web app only forwards the caller's session so that the
 * console can drive mutations without ever holding a token in JavaScript.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in again to continue' } },
      { status: 401 },
    );
  }

  let body: { action?: string; reasonCode?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/admin/review/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: body.action,
        reasonCode: body.reasonCode,
        note: body.note,
      }),
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