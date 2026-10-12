/**
 * BFF for requesting a one-time code.
 *
 * Forwarded verbatim including the delivery channel the API reports, so the form
 * can tell the person whether to wait for a WhatsApp message or an SMS. That
 * distinction is the whole point of the WhatsApp-first, SMS-fallback design: a
 * person told the wrong channel waits forever for a message that was never sent
 * to that app.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected a JSON body' } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const payload = await res.json().catch(() => null);
    return NextResponse.json(payload, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not send the code' } },
      { status: 502 },
    );
  }
}