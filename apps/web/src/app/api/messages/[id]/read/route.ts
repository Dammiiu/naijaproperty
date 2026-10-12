/**
 * BFF for marking a conversation read.
 *
 * Separate from the read route because Next.js will not route `POST` to
 * `/api/messages/[id]` alongside the `GET`/`POST` that handle the thread itself
 * without making the paths ambiguous. One endpoint, one job.
 */

import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAccessToken } from '@/lib/session';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const token = await getAccessToken();
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  try {
    const res = await fetch(`${API_URL}/api/v1/conversations/${id}/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      /*
       * An empty JSON body with a JSON content type is a 400 from Fastify, not a
       * harmless no-op. The endpoint takes no parameters, so `{}` is sent to keep
       * the contract honest rather than leaving the content type off and relying
       * on the server not caring.
       */
      body: '{}',
      cache: 'no-store',
    });
    return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}